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
import { allCommands, dispatch, type CommandDeps } from './commands.js'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildApprovalKeyboard,
  buildAskKeyboard,
  type AskLayout,
  closeGateway,
  connectGateway,
  createStream,
  type StreamHandle,
  drainRelayed,
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
  syncCommandPanel,
  onBeforeSend,
  type InboundMessage,
} from './qq.js'

/**
 * Mutable and persisted. A value chosen with /cwd or /mode outranks the env
 * default: it is the operator's most recent explicit decision, and the env var
 * only describes how this process happened to be launched.
 */
let workdir = ''
let permissionMode = ''
/**
 * How much of the work rides along with the answer.
 *
 * `full` is the whole trace — thinking summaries, each tool with its
 * arguments, and what the shell printed back. `balanced` keeps only the
 * heartbeat of it: that thinking is happening, and which tools went by. `off`
 * is the answer alone.
 *
 * Defaults to `full`: a long task that shows nothing for ten minutes is
 * indistinguishable from a hung one, and the trace is what tells them apart.
 */
type TraceLevel = 'full' | 'balanced' | 'off'
let traceLevel: TraceLevel = 'full'

/**
 * How long the trace may stay silent before it says something anyway.
 *
 * Nothing is emitted while a tool runs, so a thirty-second command looks
 * exactly like a dead process. A dot every few seconds costs one append and
 * answers the only question being asked: is it still going?
 */
const HEARTBEAT_MS = 6000
/** Cleared and rebuilt per session, so a torn-down query leaves none behind. */
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000
const QUESTION_TIMEOUT_MS = 15 * 60 * 1000

/**
 * End the turn's growing message, so whatever comes next starts a new one.
 *
 * Anything sent mid-turn as its own message — an approval prompt, a question
 * with buttons — lands *below* a stream that is still open above it. Keep
 * writing and the text grows into a message the operator has already scrolled
 * past to answer, which reads as the past editing itself. Sealing first puts
 * the reply underneath the thing it is replying to, where it happened.
 *
 * Returns whether there was anything to seal.
 *
 * Assigned per turn by `runSession`; a no-op between turns.
 */
let sealStream: () => Promise<boolean> = async () => false

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
rather than read a description of — put MEDIA:/absolute/path on a line of its
own, starting at column zero with nothing before or after it. It is sent as a
native QQ attachment and the line itself is removed, so write the sentence
around it as if the file were already attached. Anything indented, or with text
beside it, is left alone as ordinary writing — which is how you quote this
format when explaining it rather than using it. Images they send you arrive as
images; you can look at them directly.

QQ allows one attachment per message, so every MEDIA line is another message
and another buzz in their pocket. One or two files, send them as they are.
Three or more, always zip them and send the single archive instead — never a
row of MEDIA lines. Zipping costs the recipient nothing: QQ on a phone previews
the images inside an archive without extracting it, so twenty pictures arrive
as one message and are still twenty pictures they can flip through.

To ask them something, call mcp__qq__qq_ask with your question and 2-8 short
options. It renders as tappable buttons and blocks until they answer, and they
can also reply in their own words. Use it for a real fork — an ambiguous
request, a missing detail, a confirmation before something hard to undo — not
for things you can settle by looking. There is no terminal question tool here.

Tool calls that need approval are relayed to their phone as buttons, so an
approval can take minutes to come back. That is normal; keep working once it
lands. If they deny something, take the denial as the answer and say what you
would do instead rather than retrying it another way.

This machine has a qq-notify command, and a skill describing it, for sending
this person a QQ message from elsewhere. It is not for you: it exists so that
sessions without a QQ connection can borrow yours. You are the QQ connection.
Running it would mail a letter to the room you are standing in — and it would
announce to you, next turn, that someone else had sent it. Just say the thing.
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

  /**
   * Abandon the waiters left behind by a closed session.
   *
   * `waiting` is shared across iterators, so a torn-down query leaves its
   * resolve function at the head of the queue. The next message would be handed
   * to that orphan — delivered into an iterator nobody reads — and silently
   * lost. Buffered messages are kept: those have not been claimed by anyone.
   */
  detachWaiters(): void {
    this.waiting.length = 0
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

/**
 * Slash commands the operator ran since the agent last heard from them.
 *
 * The bridge handles commands entirely on its own — the agent never sees the
 * command, its arguments, or its output. Left unsaid, that produces an agent
 * reasoning about a working directory that moved, or one that believes it
 * finished work the operator interrupted. Even a command with no side effect is
 * a signal worth passing on: someone reading /help is working out what this
 * thing can do.
 */
type CommandRecord = { name: string; args: string; at: number; note?: string }

const commandLog: CommandRecord[] = []

function recordCommand(name: string, args: string): void {
  commandLog.push({ name, args, at: Date.now() })
}

/** Attach an explanation to the command currently running. */
function noteToAgent(text: string): void {
  const last = commandLog[commandLog.length - 1]
  if (last) last.note = last.note ? `${last.note}\n${text}` : text
  else commandLog.push({ name: 'unknown', args: '', at: Date.now(), note: text })
  log(`command note: ${text}`)
}

const xmlAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

/**
 * Prepend the command log to the operator's message.
 *
 * It rides along with a real message rather than arriving as its own turn: a
 * turn of its own would have the agent respond to the event instead of to the
 * person.
 */
function withCommandLog(text: string): string {
  const relayed = drainRelayed()
  if (!commandLog.length && !relayed.length) return text

  const hhmm = (at: number) =>
    new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

  const lines: string[] = []

  if (commandLog.length) {
    lines.push(
      `操作者在此期间执行了 ${commandLog.length} 条斜杠指令。你看不到指令本身及其输出，以下是摘要：`,
    )
    for (const c of commandLog) {
      const attrs = `name="${xmlAttr(c.name)}"${c.args ? ` args="${xmlAttr(c.args)}"` : ''} time="${hhmm(c.at)}"`
      lines.push(c.note ? `<command ${attrs}>\n${c.note}\n</command>` : `<command ${attrs} />`)
    }
    commandLog.length = 0
  }

  if (relayed.length) {
    lines.push(
      `本机另有 ${relayed.length} 条消息借这条 QQ 通道发给了操作者。不是你发的，你也不知道操作者作何反应；` +
        `若对方接下来提到你没印象的事，多半指的是这个：`,
    )
    for (const r of relayed) {
      const attrs = `from="${xmlAttr(r.from)}"${r.cwd ? ` cwd="${xmlAttr(r.cwd)}"` : ''} time="${hhmm(r.at)}"`
      lines.push(`<relayed ${attrs}>\n${r.text}\n</relayed>`)
    }
  }

  return [
    '<harness-reminder>',
    ...lines,
    '</harness-reminder>',
    '',
    text,
  ].join('\n')
}

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

  // A stream is bound to the inbound message it replies to and cannot be moved
  // to a newer one. Left open while the operator says something else, the reply
  // goes on growing inside a message that now sits above their words — from
  // their side, a message they already read is editing itself while they watch.
  //
  // Every inbound path gets this, not just the one that reaches the agent: a
  // slash command is answered from here and never touches the queue, and its
  // answer landing under a still-growing reply looks exactly as wrong.
  await sealStream()

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

  const text = withCommandLog([msg.content, ...notes].filter(Boolean).join('\n'))
  log(`inbound from ${msg.openid.slice(0, 8)}: ${msg.content.slice(0, 60)}${blocks.length ? ` (+${blocks.length} 图)` : ''}`)

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

const STATE_FILE = join(STATE_DIR, 'session.json')

/**
 * What survives a restart.
 *
 * The session id matters most — without it every restart starts a fresh
 * conversation — but workdir and permission mode are just as load-bearing:
 * a bridge that forgets them silently runs the next task in the wrong
 * directory, or under stricter rules than the operator last chose.
 */
type BridgeState = {
  session_id?: string | null
  workdir?: string
  permission_mode?: string
  trace_level?: TraceLevel
}

function loadState(): BridgeState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as BridgeState
  } catch {
    return {}
  }
}

function patchState(patch: BridgeState): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({ ...loadState(), ...patch }, null, 2))
  } catch (err) {
    log('failed to persist state:', err)
  }
}

function loadSessionId(): string | null {
  return loadState().session_id ?? null
}

function saveSessionId(id: string | null): void {
  patchState({ session_id: id })
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
      patchState({ workdir: path })
    },
    restartSession: reason => {
      restartReason = reason
      activeQuery?.close()
    },
    sessionId: loadSessionId,
    setSessionId: saveSessionId,
    noteToAgent,
    recordCommand,
    permissionMode: () => permissionMode,
    setPermissionMode: mode => {
      permissionMode = mode
      patchState({ permission_mode: mode })
    },
    verbose: () => traceLevel,
    setVerbose: level => {
      traceLevel = level as TraceLevel
      patchState({ trace_level: level as TraceLevel })
    },
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

const MEDIA_LINE_RE = /^MEDIA:[ \t]*(\S.*?)[ \t]*$/gm

// ------------------------------------------------------------- trace summaries
//
// A bare tool name says almost nothing: "Bash" three times in a row could be
// one command retried or three unrelated ones. The arguments are what make the
// trace readable — and they are also where it could get away from us, since a
// Read result is an entire file. So each tool gets a deliberate one-line shape,
// and only the tools whose output is short enough to be worth reading get one.

/** How much of a command or path survives into the trace. */
const TRACE_ARG_LIMIT = 140
/** How much of a tool's output does, and over how many lines. */
const TRACE_OUT_LINES = 4
const TRACE_OUT_LIMIT = 110

/** Collapse whitespace and clip, so one argument stays one line. */
function oneLine(value: unknown, limit = TRACE_ARG_LIMIT): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** Paths are usually inside the workdir; the prefix is noise once it repeats. */
function shortPath(value: unknown): string {
  const path = String(value ?? '')
  const rel = workdir && path.startsWith(workdir) ? path.slice(workdir.length + 1) : path
  return oneLine(rel || path)
}

/**
 * The trace line for a tool call, or null to leave it out.
 *
 * The bridge's own tools are left out: they exist to talk to the operator, so
 * narrating "asking you a question" directly above the question is telling
 * someone what you are about to tell them.
 */
function summariseTool(name: string, input: Record<string, any>): string | null {
  if (name.startsWith('mcp__qq__')) return null

  const arg = (() => {
    switch (name) {
      case 'Bash':
        return oneLine(input.command)
      case 'Read':
      case 'Write':
        return shortPath(input.file_path)
      case 'Edit': {
        const delta = String(input.new_string ?? '').length - String(input.old_string ?? '').length
        return `${shortPath(input.file_path)} ${delta >= 0 ? '+' : '−'}${Math.abs(delta)}`
      }
      case 'Grep':
        return oneLine(input.pattern)
      case 'Glob':
        return oneLine(input.pattern)
      case 'WebFetch':
        return oneLine(input.url)
      case 'Task':
        return oneLine(input.description)
      default:
        return ''
    }
  })()

  return arg ? `⚙️ ${name}  ${arg}` : `⚙️ ${name}`
}

/**
 * The trace lines for a tool's output, or null.
 *
 * Only Bash: its output is the point of running it, and it is the one tool
 * whose result the operator would otherwise have to take on faith. A Read
 * result is a whole file and a Grep result can be hundreds of matches — those
 * belong to the agent, not to the trace.
 */
function summariseResult(name: string, content: unknown): string | null {
  if (name !== 'Bash') return null
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c: any) => (c?.type === 'text' ? c.text : '')).join('')
      : ''

  const lines = text.split('\n').filter(l => l.trim())
  if (!lines.length) return null

  const shown = lines.slice(0, TRACE_OUT_LINES).map(l => `   ${oneLine(l, TRACE_OUT_LIMIT)}`)
  const hidden = lines.length - TRACE_OUT_LINES
  if (hidden > 0) shown.push(`   … 另有 ${hidden} 行`)
  return shown.join('\n')
}

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
      // Logged, not reported: the operator asked for a file, not for an
      // explanation of why a line they never wrote did not work.
      log(`failed to send ${path}:`, err)
    }
  }
}

/**
 * Turns the token stream into whole lines, because a line is the smallest unit
 * that can be judged.
 *
 * A MEDIA line has to be recognised before any of it is sent — once "MEDIA:/tmp"
 * is on screen it cannot be taken back — and markdown that is split mid-token
 * renders as literal asterisks until the closing one arrives. Whole lines avoid
 * both, and read better than characters appearing one at a time.
 */
/**
 * Which kind of content a push carries.
 *
 * `prose` is the reply itself — markdown, and the only place a MEDIA line
 * means anything. `trace` is the work behind it (thinking summaries, tool
 * calls), which goes inside a fenced code block: QQ collapses those past
 * fifteen lines, so a long task folds itself away instead of burying the
 * answer, and nothing inside a fence is parsed as markdown or as a MEDIA line.
 */
type Channel = 'prose' | 'trace'

class LineStreamer {
  private buffer = ''
  private stream: StreamHandle | null = null
  /** Text that missed the stream and has to go out as an ordinary message. */
  private overflow = ''
  private channel: Channel = 'prose'
  /** Whether the last text handed to the stream ended a line. */
  private atStreamLineStart = true

  constructor(
    private readonly open: () => StreamHandle,
    private readonly sendMedia: (path: string) => Promise<void>,
    private readonly sendText: (text: string) => Promise<void>,
  ) {}

  /**
   * Whether `buffer` starts at the beginning of a line, and so might still turn
   * out to be a MEDIA line.
   */
  private atLineStart = true

  async push(delta: string, channel: Channel = 'prose'): Promise<void> {
    if (channel !== this.channel) await this.switchTo(channel)
    this.buffer += delta

    const cut = this.buffer.lastIndexOf('\n')
    if (cut >= 0) {
      const complete = this.buffer.slice(0, cut + 1)
      this.buffer = this.buffer.slice(cut + 1)
      const wasAtStart = this.atLineStart
      this.atLineStart = true
      await this.emit(complete, wasAtStart)
    }

    // Waiting for the newline is only ever about recognising a MEDIA line, and
    // that is decided by the first few characters. Once the line cannot be one,
    // release it in small pieces — otherwise a paragraph-long line sits invisible
    // while a short one appears at once, and the reply arrives in lurches.
    //
    // Inside a fence there is no MEDIA line to wait for and nothing to gain:
    // released mid-line, a thinking summary twitches forward a few characters
    // at a time in a box the eye is already skimming. Whole lines only.
    if (
      this.channel === 'prose' &&
      this.buffer.length >= LineStreamer.CHUNK &&
      !this.mightBeMedia()
    ) {
      const chunk = this.buffer
      this.buffer = ''
      this.atLineStart = false
      await this.emit(chunk, false)
    }
  }

  /**
   * Close one channel and open the other. The fence character is the same
   * either way — ``` both ends the code block and starts it — so a switch is
   * always exactly one fence, whichever direction it goes.
   */
  private async switchTo(next: Channel): Promise<void> {
    if (this.buffer) {
      const rest = this.buffer
      const wasAtStart = this.atLineStart
      this.buffer = ''
      this.atLineStart = true
      await this.emit(rest, wasAtStart)
    }
    await this.writeFence(next === 'trace')
    this.channel = next
  }

  /**
   * Emit a fence on its own line, adding the newline it needs to be one.
   *
   * The opening one is tagged `text`: left untagged, QQ guesses a language and
   * syntax-highlights a paragraph of prose — `if` and `while` come out purple,
   * and one apostrophe turns the rest of the thought into an unterminated
   * string. A language that has no keywords renders it as what it is.
   */
  private async writeFence(open: boolean): Promise<void> {
    const lead = this.atStreamLineStart ? '' : '\n'
    await this.writeThrough(`${lead}\`\`\`${open ? LineStreamer.TRACE_LANG : ''}\n`)
  }

  private static readonly TRACE_LANG = 'text'

  /**
   * Write straight through, skipping the line buffer — for a heartbeat, whose
   * whole purpose is to appear now rather than when a line happens to end.
   *
   * Refuses when a line is half-written, rather than cutting in: a dot in the
   * middle of a sentence is worse than a late dot, and the next tick will find
   * a better moment.
   */
  async pushNow(text: string, channel: Channel): Promise<boolean> {
    if (this.buffer) return false
    if (channel !== this.channel) await this.switchTo(channel)
    await this.writeThrough(text)
    return true
  }

  /**
   * A growing message has a maximum size. When QQ says this one is nearly
   * there, close it and carry on in the next — reopening the fence, because a
   * code block does not survive the message boundary and the trace would
   * otherwise continue as bare text in the new one.
   */
  private async rollStream(): Promise<void> {
    const spent = this.stream
    this.stream = null
    try {
      // Close the fence before closing the message, or the one being left
      // behind keeps an open code block and swallows its own last line.
      if (this.channel === 'trace' && spent && !spent.failed) await spent.write('```\n')
      await spent?.end()
    } catch (err) {
      log('failed to close a full stream:', err)
    }
    this.atStreamLineStart = true
    if (this.channel !== 'trace') return
    const next = this.open()
    this.stream = next
    if (!next.failed) await next.write(`\`\`\`${LineStreamer.TRACE_LANG}\n`)
  }

  private static readonly CHUNK = 12
  private static readonly MEDIA_PREFIX = 'MEDIA:'

  /** True while the partial line could still grow into `MEDIA:...`. */
  private mightBeMedia(): boolean {
    if (!this.atLineStart) return false
    const t = this.buffer
    if (!t) return true
    return (
      t.startsWith(LineStreamer.MEDIA_PREFIX) ||
      LineStreamer.MEDIA_PREFIX.startsWith(t.slice(0, LineStreamer.MEDIA_PREFIX.length))
    )
  }

  /** Flush the trailing partial line, close the stream, and post any overflow. */
  async finish(): Promise<void> {
    if (this.buffer) {
      const rest = this.buffer
      const wasAtStart = this.atLineStart
      this.buffer = ''
      await this.emit(rest, wasAtStart)
    }
    // A turn that ends mid-trace — interrupted, or one that never got round to
    // an answer — would otherwise leave the fence open and swallow whatever the
    // next message renders beneath it.
    if (this.channel === 'trace') {
      await this.writeFence(false)
      this.channel = 'prose'
    }
    await this.stream?.end()
    this.stream = null
    if (this.overflow.trim()) {
      const rest = this.overflow
      this.overflow = ''
      await this.sendText(rest.trim())
    }
  }

  /**
   * Hand text to the open stream, opening one on first use and diverting to
   * `overflow` once QQ has refused. The single place `atStreamLineStart` is
   * maintained, so a fence always lands on its own line.
   */
  private async writeThrough(chunk: string): Promise<void> {
    if (!chunk) return
    if (this.stream?.full) await this.rollStream()
    this.stream ??= this.open()
    this.atStreamLineStart = chunk.endsWith('\n')
    if (this.stream.failed) {
      // Out of passive quota, or QQ refused. Hold it back rather than drop it;
      // finish() posts it as a normal message so nothing is lost and nothing
      // already on screen gets repeated.
      this.overflow += chunk
      return
    }
    await this.stream.write(chunk)
  }

  private async emit(text: string, firstLineIsStart: boolean): Promise<void> {
    // Nothing inside a fence is a MEDIA line or markdown, so it needs none of
    // the line-by-line inspection below — and must not get it, or a trace that
    // quoted a MEDIA line would send the file.
    if (this.channel === 'trace') {
      // A thinking summary quoting a fence would close the block it is inside
      // and hand the rest of the turn to the markdown parser — and a fence is
      // a line-level rule, so a backslash in front of it changes nothing.
      //
      // Only a run of them is dangerous, and only the run has to break: a lone
      // backtick inside a fence is already literal. Keeping the first one and
      // widening the rest leaves `foo` untouched and ``` unable to close
      // anything. Fences the streamer writes itself bypass this and stay real.
      //
      // Guarded on `text`, not `text.trim()`: prose drops whitespace-only
      // writes because QQ rejects a message made of nothing, but inside a
      // fence a blank line is content — it is the separator between entries,
      // and trimming it away silently removed every one of them.
      if (text) {
        await this.writeThrough(text.replace(/`{2,}/g, m => `\`${'｀'.repeat(m.length - 1)}`))
      }
      return
    }

    let prose = ''
    // Only a real line start can be a MEDIA line. A fragment released mid-line
    // has already been ruled out, and re-testing it would let text that merely
    // begins with "MEDIA:" after a break be mistaken for one.
    let lineStart = firstLineIsStart
    const flush = async () => {
      const chunk = prose
      prose = ''
      if (!chunk.trim()) return
      await this.writeThrough(chunk)
    }

    // Keeping the newline with its line, so a split never loses one.
    for (const line of text.split(/(?<=\n)/)) {
      const media = lineStart
        ? /^MEDIA:[ \t]*(\S.*?)[ \t]*$/.exec(line.replace(/\n$/, ''))
        : null
      lineStart = line.endsWith('\n')
      if (!media) {
        prose += line
        continue
      }
      // A file interrupts the stream: the text before it is finished and sent,
      // the attachment goes out, and what follows starts a new one. That is what
      // puts the picture where the writing referred to it, instead of stacking
      // every image after the prose has ended.
      await flush()
      await this.stream?.end()
      this.stream = null
      this.atStreamLineStart = true
      await this.sendMedia(media[1])
    }
    await flush()
  }
}

/** Run one agent session until it ends. Returns when the query closes. */
async function runSession(): Promise<void> {
  // The previous session's iterator may still be parked on this queue.
  queue.detachWaiters()

  const resume = loadSessionId()
  log(resume ? `resuming session ${resume}` : 'starting a new session')

  const q = query({
    prompt: queue,
    options: {
      systemPrompt: { type: 'preset', preset: 'claude_code', append: OPERATOR_CONTEXT },
      cwd: workdir,
      // 'auto' lets a classifier clear the routine calls and only escalate what
      // it considers risky. 'default' escalates every write and every command,
      // which on a phone means approving your way through the whole task.
      permissionMode,
      resume: resume ?? undefined,
      // The terminal question tool has no UI here — nobody is watching a
      // terminal. Left enabled it renders into the void and comes back
      // unanswered. mcp__qq__qq_ask is its replacement.
      disallowedTools: ['AskUserQuestion'],
      // Needed for streamed replies: without it the SDK only reports finished
      // assistant messages, and there is nothing to stream.
      includePartialMessages: true,
      // The raw chain of thought is never returned by any model; 'summarized'
      // asks for the readable digest instead. Without it the default is
      // 'omitted' — thinking blocks still arrive, with empty text — and the
      // trace would show tool calls with nothing between them.
      thinking: { type: 'adaptive', display: 'summarized' },
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

  /**
   * One stream per turn, not per assistant message.
   *
   * A turn is "say a little, call a tool, say a little more", and each of those
   * spoken parts is its own assistant message. Closing the stream at the end of
   * each one turned a single answer into a series of QQ messages, and every one
   * of them spent a passive reply — four of which exist per inbound message, so
   * a long task ran out before it reached its own conclusion. Held open until
   * `result`, the whole turn costs one.
   */
  let streamer: LineStreamer | null = null
  /**
   * Whether the current assistant message's text already went out as deltas.
   * The finished message arrives after them and would otherwise repeat it.
   */
  let streamedText = false

  async function closeStreamer(): Promise<boolean> {
    if (!streamer) return false
    const s = streamer
    streamer = null
    try {
      await s.finish()
    } catch (err) {
      log('failed to close stream:', err)
    }
    return true
  }

  /** Write into the fenced trace block. Newlines are the caller's to place. */
  async function trace(text: string): Promise<void> {
    try {
      streamer ??= newStreamer()
      await streamer.push(text, 'trace')
      traceTail = text
      lastTraceAt = Date.now()
    } catch (err) {
      // The trace is commentary. Losing a line of it must never take down the
      // turn that was busy producing the actual answer.
      log('trace push failed:', err)
    }
  }

  /** Write into the trace immediately, without waiting for a line to end. */
  async function traceNow(text: string): Promise<void> {
    try {
      streamer ??= newStreamer()
      if (await streamer.pushNow(text, 'trace')) {
        traceTail = text
        lastTraceAt = Date.now()
      }
    } catch (err) {
      log('trace push failed:', err)
    }
  }

  /** The last text written to the trace, so newlines are never doubled. */
  let traceTail = ''
  /** Whether the block already holds an entry. */
  let traceStarted = false
  /** In balanced mode, what the running entry is, so tools can accumulate. */
  let lastKind: 'thinking' | 'tools' | null = null
  /** When the trace last said anything, for the heartbeat to measure against. */
  let lastTraceAt = Date.now()

  /** End the previous entry cleanly and leave a blank line before the next. */
  async function traceBreak(): Promise<void> {
    if (!traceStarted) return
    if (!traceTail.endsWith('\n')) await trace('\n')
    await trace('\n')
  }

  /** Close the current entry's last line without opening a gap after it. */
  async function traceEndLine(): Promise<void> {
    if (traceStarted && !traceTail.endsWith('\n')) await trace('\n')
  }

  sealStream = closeStreamer

  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(() => {
    // Only while a reply is actually open, and only once the trace has gone
    // quiet — a dot next to something that just arrived says nothing.
    if (traceLevel === 'off' || !streamer) return
    if (Date.now() - lastTraceAt < HEARTBEAT_MS) return
    void traceNow('·')
  }, HEARTBEAT_MS)

  /** Which content block the deltas currently belong to. */
  let block: string | null = null
  /** tool_use id → name, so a result can be matched to the call that made it. */
  const toolNames = new Map<string, string>()

  function newStreamer(): LineStreamer {
    return new LineStreamer(
      () => {
        const user = requireUser()
        return createStream(user, lastInboundMsgId.get(user))
      },
      async path => {
        try {
          const user = requireUser()
          await sendFile(user, path, lastInboundMsgId.get(user))
          log(`sent file ${path}`)
        } catch (err) {
          log(`failed to send ${path}:`, err)
        }
      },
      async text => {
        const user = requireUser()
        await sendToQQ(user, text, lastInboundMsgId.get(user))
      },
    )
  }

  for await (const message of q as any) {
    const m = message as any

    if (m.type === 'system' && m.subtype === 'init') {
      // Persist immediately: a crash before the first reply should still leave
      // a resumable session behind.
      if (m.session_id) saveSessionId(m.session_id)
    } else if (m.type === 'stream_event') {
      // Everything the operator sees is driven from here rather than from the
      // finished assistant message, because only the event order says what
      // happened when: a thought, then the call it led to, then the next
      // thought. Reading tool calls off the finished message instead would
      // stack them after their own reasoning.
      const ev = m.event
      if (ev?.type === 'content_block_start') {
        block = ev.content_block?.type ?? null
        if (block === 'thinking' && traceLevel === 'full') {
          await traceBreak()
          await trace('💭 ')
          traceStarted = true
          lastKind = 'thinking'
        } else if (block === 'thinking' && traceLevel === 'balanced' && lastKind !== 'thinking') {
          // One line per stretch of thinking, not per block: several in a row
          // say nothing more than the first, and the point here is only that
          // something is happening.
          await traceBreak()
          await trace('💭 思考中……\n')
          traceStarted = true
          lastKind = 'thinking'
        }
      } else if (ev?.type === 'content_block_delta') {
        const delta = ev.delta
        if (delta?.type === 'text_delta') {
          streamer ??= newStreamer()
          streamedText = true
          // Prose closes the block; a later one starts its own entry list.
          traceStarted = false
          lastKind = null
          try {
            await streamer.push(delta.text)
          } catch (err) {
            log('stream push failed:', err)
          }
        } else if (delta?.type === 'thinking_delta' && traceLevel === 'full') {
          await trace(delta.thinking)
        }
      } else if (ev?.type === 'content_block_stop') {
        // A thinking summary may or may not end its own last line, and the
        // trace only flushes whole lines — without this the last thought can
        // sit in the buffer until something else happens to end one.
        if (block === 'thinking' && traceLevel === 'full') await traceEndLine()
        block = null
      }
    } else if (m.type === 'assistant') {
      // The finished message arrives after its deltas. Its text is only needed
      // when the stream never got off the ground — then this is where the whole
      // thing goes out the old way. Its tool calls, though, are needed every
      // time: during streaming a tool's input is still arriving in fragments,
      // and only here is it whole enough to summarise. This still lands after
      // the thinking that produced it and before the call runs, which is the
      // order it happened in.
      for (const b of m.message?.content ?? []) {
        if (b.type === 'text' && b.text.trim() && !streamedText) {
          try {
            await deliverReply(b.text.trim())
          } catch (err) {
            log('failed to deliver reply:', err)
          }
        } else if (b.type === 'tool_use') {
          toolNames.set(b.id, b.name)
          if (traceLevel === 'full') {
            const line = summariseTool(b.name, b.input ?? {})
            if (line) {
              await traceBreak()
              await trace(`${line}\n`)
              traceStarted = true
              lastKind = 'tools'
            }
          } else if (traceLevel === 'balanced' && !b.name.startsWith('mcp__qq__')) {
            // Names accumulate along one line — a stream can only append, so
            // the line is built as it goes rather than rewritten at the end.
            // Written straight through: without a newline to end it, a
            // buffered write would sit invisible until the next entry.
            if (lastKind === 'tools') {
              await traceNow(`、${b.name}`)
            } else {
              await traceBreak()
              await traceNow(`⚙️ ${b.name}`)
              traceStarted = true
              lastKind = 'tools'
            }
          }
        }
      }
      streamedText = false
    } else if (m.type === 'user') {
      // Tool results come back as a user turn. Only some are worth showing,
      // and knowing which needs the name from the call that asked for it.
      for (const b of m.message?.content ?? []) {
        if (b.type !== 'tool_result') continue
        const name = toolNames.get(b.tool_use_id)
        toolNames.delete(b.tool_use_id)
        if (!name || traceLevel !== 'full') continue
        const out = summariseResult(name, b.content)
        if (out) await trace(`${out}\n`)
      }
    } else if (m.type === 'result') {
      // The one place the stream closes. A turn can also end without a final
      // assistant message (interrupt, error), and this catches that too rather
      // than leaving it half-written.
      await closeStreamer()
      block = null
      streamedText = false
      traceStarted = false
      traceTail = ''
      lastKind = null
      toolNames.clear()
      log(`turn finished: ${m.subtype}, turns=${m.num_turns}`)
    }
  }
}

async function main(): Promise<void> {
  const state = loadState()
  workdir = state.workdir ?? process.env.QQ_BRIDGE_CWD ?? process.env.HOME!
  permissionMode = state.permission_mode ?? process.env.QQ_PERMISSION_MODE ?? 'auto'
  traceLevel = state.trace_level ?? 'full'

  // The linearity invariant, installed once: every standalone message closes
  // the open stream on its way out, whoever sends it and whenever it is added.
  onBeforeSend(async () => {
    await sealStream()
  })

  if (!HAS_CREDENTIALS) {
    log('QQ_APP_ID / QQ_CLIENT_SECRET missing — run: bun run onboard.ts')
    process.exit(1)
  }

  await connectGateway({ onMessage: handleMessage, onButton: handleButton })
  log(`bridge up, workdir=${workdir}, mode=${permissionMode}, state=${STATE_DIR}`)

  // Republish the command panel, so editing a command is enough to change what
  // the operator sees under "/". Safe to repeat: the sync updates the existing
  // panel rather than adding one. Deliberately not awaited and never fatal — a
  // bridge that will not start because a cosmetic list failed to update would
  // be a bad trade, and the panel QQ already has stays usable meanwhile.
  void syncCommandPanel(allCommands().map(c => ({ name: `/${c.name}`, desc: c.summary })))
    .then(id => log(`command panel synced (${id})`))
    .catch(err => log('command panel sync failed, keeping the existing one:', err))

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

/**
 * Leave the conversation in a finished state before going.
 *
 * A stream is only over once QQ is told so; killed mid-write, the message
 * keeps its typing indicator blinking forever, and the operator is left
 * watching a reply that will never arrive from a process that no longer
 * exists. Sealing sends that closing frame, and the notice explains the
 * silence — restarts are frequent here, since the bridge is often what is
 * being edited.
 *
 * Bounded on purpose: launchd escalates to SIGKILL if a job lingers, and a
 * courtesy message is not worth being killed halfway through sending.
 */
const SHUTDOWN_GRACE_MS = 3000
let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log(`${signal} received, shutting down`)
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref()
  try {
    // Only when a reply was actually in flight. A restart while idle needs no
    // apology, and nobody wants a notification for one.
    if (await sealStream()) {
      const user = requireUser()
      await sendToQQ(user, '⏸ claude-in-qq 正在断开连接。', lastInboundMsgId.get(user))
    }
  } catch (err) {
    log('shutdown notice failed:', err)
  }
  closeGateway()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

await main()
