#!/usr/bin/env bun
/**
 * Drive Claude Code from QQ private chat.
 *
 * The bridge owns the agent session rather than attaching to one: QQ messages
 * are streamed into a long-lived query(), the message stream is read back for
 * replies and progress, and tool approvals are answered with buttons on the
 * phone. That ownership is the point — a channel plugin can only push messages
 * into someone else's session, so it can never interrupt, re-configure, or
 * report on it.
 */

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { dispatch, type CommandDeps } from './commands.js'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildApprovalKeyboard,
  buildAskKeyboard,
  type AskLayout,
  closeGateway,
  connectGateway,
  dropExpiredPending,
  fetchImage,
  HAS_CREDENTIALS,
  isAllowed,
  lastInboundMsgId,
  LETTERS,
  loadAccess,
  log,
  PAIRING_TTL_MS,
  randomId,
  saveAccess,
  sendFile,
  sendToQQ,
  STATE_DIR,
  type InboundMessage,
} from './qq.js'

/** Mutable: /cwd retargets the agent, which means rebuilding the session. */
let workdir = process.env.QQ_BRIDGE_CWD ?? process.env.HOME!
const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000
const QUESTION_TIMEOUT_MS = 15 * 60 * 1000
/** Don't narrate every tool call; report at most this often. */
const PROGRESS_INTERVAL_MS = 25_000

/**
 * Appended to Claude Code's own system prompt. Without it the agent assumes a
 * terminal it can print to and a human watching it, and both assumptions are
 * wrong here.
 */
const OPERATOR_CONTEXT = `
You are reached through QQ private chat, not a terminal. Nobody is watching a
screen where you run — the person is on their phone.

Anything you write as normal response text is delivered to them automatically.
Do not call a tool to send it, and do not write "I'll message you" — the words
themselves are the message.

Replies render as markdown, and QQ supports the whole common subset: bold,
italic, inline code, headings, ordered and unordered lists, fenced code blocks,
links, and tables. Write markdown normally.

One trap: underscores and asterisks inside bare text are read as formatting, so
a path like src/__init__.py turns italic and a glob like a*b*c turns bold. Wrap
every path, identifier, flag, glob, and regex in backticks. This is ordinary
good markdown practice, but here it is load-bearing — you cannot see how your
own message rendered.

Write for a phone: lead with the outcome and keep it to a few lines. Long
replies are split across several QQ messages, which is unpleasant to read.

To hand over a file — a screenshot, a chart, a log, anything they should have
rather than read a description of — put a line of exactly MEDIA:/absolute/path
in your reply. It is sent as a native QQ attachment and the line itself is
removed, so write the sentence around it as if the file were already attached.
Images they send you arrive as images; you can look at them directly.

To ask them something, call mcp__qq__qq_ask with your question and 2-8 short
options. It renders as tappable buttons and blocks until they answer, and they
can also reply in their own words. Use it for a real fork — an ambiguous
request, a missing detail, a confirmation before something hard to undo — not
for things you can settle by looking. There is no terminal question tool here.

Tool calls that need approval are relayed to their phone as buttons, so an
approval can take minutes to come back. That is normal; keep working once it
lands. If they deny something, take the denial as the answer and say what you
would do instead rather than retrying it another way.
`.trim()

/** Whoever last wrote in. Single-operator by design; the allowlist enforces it. */
let currentUser: string | null = null

function requireUser(): string {
  if (currentUser) return currentUser
  const allowed = loadAccess().allowed
  if (allowed.length === 0) throw new Error('no allowlisted QQ user to talk to')
  return allowed[0]
}

// ------------------------------------------------------------- message stream
//
// query() consumes an AsyncIterable, so inbound QQ messages are pushed into
// this queue and pulled by the SDK as the conversation advances.

/** A text block or an inline image, the two shapes an inbound QQ message takes. */
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

type SDKUserMessage = {
  type: 'user'
  message: { role: 'user'; content: string | ContentBlock[] }
  parent_tool_use_id: null
  session_id?: string
}

class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private waiting: ((m: SDKUserMessage) => void)[] = []
  private buffered: SDKUserMessage[] = []

  push(content: string | ContentBlock[]): void {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    }
    const next = this.waiting.shift()
    if (next) next(msg)
    else this.buffered.push(msg)
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      const buffered = this.buffered.shift()
      if (buffered) {
        yield buffered
        continue
      }
      yield await new Promise<SDKUserMessage>(resolve => this.waiting.push(resolve))
    }
  }
}

const queue = new MessageQueue()

// ------------------------------------------------------------------ approvals

type Pending<T> = { resolve: (v: T) => void; timer: ReturnType<typeof setTimeout> }

const pendingApprovals = new Map<string, Pending<boolean>>()
const pendingQuestions = new Map<string, Pending<string> & { options: string[] }>()

function settleApproval(id: string, allow: boolean): boolean {
  const p = pendingApprovals.get(id)
  if (!p) return false
  clearTimeout(p.timer)
  pendingApprovals.delete(id)
  p.resolve(allow)
  log(`approval ${id} -> ${allow ? 'allow' : 'deny'}`)
  return true
}

function settleQuestion(id: string, answer: string): boolean {
  const p = pendingQuestions.get(id)
  if (!p) return false
  clearTimeout(p.timer)
  pendingQuestions.delete(id)
  p.resolve(answer)
  log(`question ${id} -> ${answer.slice(0, 60)}`)
  return true
}

/** Strip control and bidi characters: tool input is untrusted text. */
function sanitize(value: string, limit: number): string {
  const cleaned = value
    .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
  return cleaned.length > limit ? `${cleaned.slice(0, limit)} ...(truncated)` : cleaned
}

/**
 * Ask the operator to approve a tool call. Resolves false on timeout: an
 * unanswered prompt must not leave the agent running unattended forever, and
 * denying is the recoverable direction.
 */
async function askApproval(toolName: string, input: Record<string, unknown>): Promise<boolean> {
  const user = requireUser()
  const id = randomId()

  // The preview goes in a fenced block: rendered as markdown so the keyboard
  // shows, its braces and asterisks would otherwise read as formatting and
  // could disguise what is actually being approved.
  const body = [
    `**🔐 Claude 要用 ${sanitize(toolName, 40)}**`,
    '',
    '```',
    sanitize(JSON.stringify(input, null, 1), 800),
    '```',
    '',
    '点按钮，或回复 y / n',
  ].join('\n')

  await sendToQQ(user, body, lastInboundMsgId.get(user), buildApprovalKeyboard(id))

  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(id)
      log(`approval ${id} timed out, denying`)
      resolve(false)
    }, APPROVAL_TIMEOUT_MS)
    pendingApprovals.set(id, { resolve, timer })
  })
}

// ---------------------------------------------------------------- qq_ask tool

const qqTools = createSdkMcpServer({
  name: 'qq',
  version: '0.1.0',
  tools: [
    tool(
      'qq_ask',
      'Ask the operator a multiple-choice question and wait for their answer. Renders the ' +
        'options as tappable buttons on their phone and blocks until they respond, so use it ' +
        'whenever you would otherwise stop and ask — a fork in the approach, a missing detail, ' +
        'a confirmation before something hard to undo. They may also reply with free text ' +
        'instead of picking an option, in which case you get their words verbatim. ' +
        'Keep options short: 20 characters or less renders the text on the button itself.',
      {
        question: z.string().describe('The question, stated plainly'),
        options: z.array(z.string()).min(2).max(8).describe('Between 2 and 8 choices'),
      },
      async ({ question, options }) => {
        const user = requireUser()
        const id = randomId()
        const { keyboard, mode } = buildAskKeyboard(id, options)

        const lines = [`**${question}**`, '']
        if (mode === 'letters') {
          // Buttons carry only a letter, so the list has to carry the meaning.
          options.forEach((opt, i) => lines.push(`${LETTERS[i]}：${opt}`))
          lines.push('')
        } else if (mode === 'truncated') {
          // Buttons are recognisable but clipped; show the full text once.
          options.forEach(opt => lines.push(`· ${opt}`))
          lines.push('')
        }
        lines.push('点按钮选择，或直接打字回答')

        await sendToQQ(user, lines.join('\n'), lastInboundMsgId.get(user), keyboard)

        const answer = await new Promise<string>(resolve => {
          const timer = setTimeout(() => {
            pendingQuestions.delete(id)
            resolve('(操作者未在 15 分钟内回答)')
          }, QUESTION_TIMEOUT_MS)
          pendingQuestions.set(id, { resolve, timer, options })
        })

        return { content: [{ type: 'text' as const, text: answer }] }
      },
    ),
  ],
})

// -------------------------------------------------------------- inbound routing

const APPROVAL_REPLY_RE = /^\s*(y|yes|n|no)\s*$/i
const APPROVE_BUTTON_RE = /^approve:([a-km-z]{5}):(allow|deny)$/
const ASK_BUTTON_RE = /^ask:([a-km-z]{5}):(\d+)$/

async function handleMessage(msg: InboundMessage): Promise<void> {
  const access = loadAccess()
  dropExpiredPending(access)

  if (!(access.policy === 'open' || access.allowed.includes(msg.openid))) {
    // Unknown sender: never auto-promote. Hand out a code that only takes
    // effect when approved from the machine itself.
    const code = randomId(6)
    access.pending[code] = { openid: msg.openid, expires_at: Date.now() + PAIRING_TTL_MS }
    saveAccess(access)
    log(`pairing code ${code} issued for ${msg.openid}`)
    await sendToQQ(
      msg.openid,
      `你还没有获得授权。\n配对码：${code}\n请在本机运行：bun run pair ${code}\n（10 分钟内有效）`,
      msg.id,
    )
    return
  }

  currentUser = msg.openid
  lastInboundMsgId.set(msg.openid, msg.id)

  // Commands outrank a pending prompt: an open question swallows arbitrary text
  // as its answer, so /stop would never reach anything if it were checked after.
  if (await dispatch(msg.content, commandDeps(msg.openid))) return

  // An open approval or question takes precedence: the agent is blocked on it,
  // so this message is the answer rather than a new instruction.
  const short = APPROVAL_REPLY_RE.exec(msg.content)
  if (short && pendingApprovals.size > 0) {
    const id = pendingApprovals.keys().next().value as string
    settleApproval(id, short[1].toLowerCase().startsWith('y'))
    return
  }

  if (pendingQuestions.size > 0) {
    const id = pendingQuestions.keys().next().value as string
    const q = pendingQuestions.get(id)!
    const letter = /^\s*([A-Za-z])\s*$/.exec(msg.content)
    let answer = msg.content
    if (letter) {
      const idx = LETTERS.indexOf(letter[1].toUpperCase())
      if (idx >= 0 && idx < q.options.length) answer = q.options[idx]
    }
    settleQuestion(id, answer)
    return
  }

  // Images are fetched and inlined: a CDN link is something Claude cannot see,
  // and QQ's links expire. Anything that is not an image still goes as a URL,
  // which is all a non-image attachment can usefully be.
  const blocks: ContentBlock[] = []
  const notes: string[] = []

  for (const att of msg.attachments) {
    if (!att.url) continue
    const isImage = att.content_type?.includes('image') || /\.(jpe?g|png|gif|webp)$/i.test(att.url)
    if (!isImage) {
      notes.push(`[文件] ${att.filename ?? ''} ${att.url}`.trim())
      continue
    }
    const image = await fetchImage(att.url, att.content_type)
    if (image) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.data },
      })
    } else {
      notes.push(`[图片下载失败] ${att.url}`)
    }
  }

  const text = [msg.content, ...notes].filter(Boolean).join('\n')
  if (blocks.length) {
    // Image first, then the words about it — the order the person sent them in.
    queue.push([...blocks, { type: 'text', text: text || '(图片)' }])
  } else {
    queue.push(text)
  }
}

async function handleButton(openid: string, buttonData: string): Promise<void> {
  // Clicking a button approves a tool call, so it is gated exactly like a message.
  if (!isAllowed(openid)) {
    log(`ignoring interaction from non-allowlisted openid ${openid}`)
    return
  }

  const approval = APPROVE_BUTTON_RE.exec(buttonData)
  if (approval) {
    settleApproval(approval[1], approval[2] === 'allow')
    return
  }

  const ask = ASK_BUTTON_RE.exec(buttonData)
  if (ask) {
    const q = pendingQuestions.get(ask[1])
    if (!q) {
      log(`click for unknown or expired question ${ask[1]}`)
      return
    }
    const choice = q.options[Number(ask[2])]
    if (choice !== undefined) settleQuestion(ask[1], choice)
    return
  }

  log(`unrecognized button_data: ${buttonData.slice(0, 60)}`)
}

// -------------------------------------------------------------- session state
//
// The agent session outlives this process. Without persisting its id, every
// restart — a crash, a deploy, an edit to this file — silently starts a new
// conversation, and the operator is left talking to someone with amnesia.

const SESSION_FILE = join(STATE_DIR, 'session.json')

function loadSessionId(): string | null {
  try {
    const data = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as { session_id?: string }
    return data.session_id ?? null
  } catch {
    return null
  }
}

function saveSessionId(id: string | null): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(SESSION_FILE, JSON.stringify({ session_id: id }, null, 2))
  } catch (err) {
    log('failed to persist session id:', err)
  }
}

// ------------------------------------------------------------------- commands

/** Set when a command needs the query torn down and rebuilt. */
let restartReason: string | null = null
let activeQuery: any = null

/**
 * Present options as buttons and wait for a choice.
 *
 * Shares the question machinery with qq_ask: a selection is the same
 * interaction, and reusing it keeps one code path for buttons, letter replies,
 * and free text.
 */
async function askChoice(
  options: string[],
  renderBody: (mode: AskLayout['mode']) => string,
): Promise<number> {
  const user = requireUser()
  const id = randomId()
  const { keyboard, mode } = buildAskKeyboard(id, options)

  await sendToQQ(user, renderBody(mode), lastInboundMsgId.get(user), keyboard)

  const answer = await new Promise<string>(resolve => {
    const timer = setTimeout(() => {
      pendingQuestions.delete(id)
      resolve('')
    }, QUESTION_TIMEOUT_MS)
    pendingQuestions.set(id, { options, resolve, timer })
  })
  return options.indexOf(answer)
}

/** Everything the command layer is allowed to touch, and nothing more. */
function commandDeps(user: string): CommandDeps {
  return {
    reply: text => sendToQQ(user, text, lastInboundMsgId.get(user)),
    askChoice,
    query: () => activeQuery,
    workdir: () => workdir,
    setWorkdir: path => {
      workdir = path
    },
    restartSession: reason => {
      restartReason = reason
      activeQuery?.close()
    },
    sessionId: loadSessionId,
    setSessionId: saveSessionId,
    counts: () => ({
      allowed: loadAccess().allowed.length,
      approvals: pendingApprovals.size,
      questions: pendingQuestions.size,
    }),
  }
}

// ------------------------------------------------------------------ main loop

/**
 * A line of exactly `MEDIA:/absolute/path` asks for that file to be sent as a
 * native attachment. Claude has no way to hand over a file otherwise — it can
 * describe a screenshot or a log, but not give it to you.
 */
/** Above this, prose is its own message so it keeps markdown rendering. */
const CAPTION_LIMIT = 200

const MEDIA_LINE_RE = /^[ \t]*MEDIA:[ \t]*(\S.*)$/gm

/** Send a reply, pulling out any MEDIA: lines and uploading those files. */
async function deliverReply(text: string): Promise<void> {
  const user = requireUser()
  const replyTo = lastInboundMsgId.get(user)

  const paths: string[] = []
  const prose = text.replace(MEDIA_LINE_RE, (_m, p: string) => {
    paths.push(p.trim())
    return ''
  })

  const remaining = prose.trim()

  // One file with a short note becomes a single captioned message — the note
  // belongs to the file. Longer prose goes separately so it keeps its markdown,
  // which a caption does not render.
  const asCaption = paths.length === 1 && remaining.length > 0 && remaining.length <= CAPTION_LIMIT
  if (remaining && !asCaption) await sendToQQ(user, remaining, replyTo)

  for (const [i, path] of paths.entries()) {
    try {
      await sendFile(user, path, replyTo, asCaption && i === 0 ? remaining : undefined)
      log(`sent file ${path}`)
    } catch (err) {
      log(`failed to send ${path}:`, err)
      await sendToQQ(user, `发送 \`${path}\` 失败：${err}`, replyTo)
    }
  }
}

/** Run one agent session until it ends. Returns when the query closes. */
async function runSession(): Promise<void> {
  const resume = loadSessionId()
  log(resume ? `resuming session ${resume}` : 'starting a new session')

  const q = query({
    prompt: queue,
    options: {
      systemPrompt: { type: 'preset', preset: 'claude_code', append: OPERATOR_CONTEXT },
      cwd: workdir,
      permissionMode: 'default',
      resume: resume ?? undefined,
      // The terminal question tool has no UI here — nobody is watching a
      // terminal. Left enabled it renders into the void and comes back
      // unanswered. mcp__qq__qq_ask is its replacement.
      disallowedTools: ['AskUserQuestion'],
      canUseTool: async (toolName: string, input: Record<string, unknown>) => {
        // This bridge's own tools only talk to the operator — they touch no
        // files, run no commands, and reach nothing outside the chat. Gating
        // them means asking permission to ask a question, which costs two
        // round trips on a phone to answer one prompt.
        if (toolName.startsWith('mcp__qq__')) {
          return { behavior: 'allow' as const, updatedInput: input }
        }
        const allow = await askApproval(toolName, input)
        return allow
          ? { behavior: 'allow' as const, updatedInput: input }
          : { behavior: 'deny' as const, message: '操作者在 QQ 上拒绝了这次调用' }
      },
      mcpServers: { qq: qqTools },
    } as any,
  })
  activeQuery = q

  let lastProgressAt = 0
  const pendingTools: string[] = []

  for await (const message of q as any) {
    const m = message as any

    if (m.type === 'system' && m.subtype === 'init') {
      // Persist immediately: a crash before the first reply should still leave
      // a resumable session behind.
      if (m.session_id) saveSessionId(m.session_id)
    } else if (m.type === 'assistant') {
      for (const block of m.message?.content ?? []) {
        if (block.type === 'text' && block.text.trim()) {
          try {
            await deliverReply(block.text.trim())
          } catch (err) {
            log('failed to deliver reply:', err)
          }
        } else if (block.type === 'tool_use') {
          // Progress exists so a long task is not silent, not to narrate every
          // step; report at an interval rather than per call.
          pendingTools.push(block.name)
          const now = Date.now()
          if (now - lastProgressAt > PROGRESS_INTERVAL_MS) {
            lastProgressAt = now
            const summary = [...new Set(pendingTools)].join('、')
            pendingTools.length = 0
            try {
              const user = requireUser()
              await sendToQQ(user, `⏳ 正在执行：${summary}`, lastInboundMsgId.get(user))
            } catch {
              // progress is best-effort
            }
          }
        }
      }
    } else if (m.type === 'result') {
      pendingTools.length = 0
      lastProgressAt = 0
      log(`turn finished: ${m.subtype}, turns=${m.num_turns}`)
    }
  }
}

async function main(): Promise<void> {
  if (!HAS_CREDENTIALS) {
    log('QQ_APP_ID / QQ_CLIENT_SECRET missing — run: bun run onboard.ts')
    process.exit(1)
  }

  await connectGateway({ onMessage: handleMessage, onButton: handleButton })
  log(`bridge up, workdir=${workdir}, state=${STATE_DIR}`)

  // The session is rebuilt rather than the process restarted: /clear and /cwd
  // both need a fresh query, and a crashed query should not take the QQ
  // connection down with it.
  while (true) {
    try {
      await runSession()
    } catch (err) {
      log('session ended with error:', err)
    }
    activeQuery = null
    if (restartReason) {
      log(`rebuilding session after /${restartReason}`)
      restartReason = null
      continue
    }
    await new Promise(r => setTimeout(r, 1000))
  }
}

process.on('SIGINT', () => {
  closeGateway()
  process.exit(0)
})
process.on('SIGTERM', () => {
  closeGateway()
  process.exit(0)
})

await main()
