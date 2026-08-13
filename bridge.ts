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
import {
  buildApprovalKeyboard,
  buildAskKeyboard,
  closeGateway,
  connectGateway,
  dropExpiredPending,
  HAS_CREDENTIALS,
  isAllowed,
  lastInboundMsgId,
  LETTERS,
  loadAccess,
  log,
  PAIRING_TTL_MS,
  randomId,
  saveAccess,
  sendToQQ,
  STATE_DIR,
  type InboundMessage,
} from './qq.ts'

const WORKDIR = process.env.QQ_BRIDGE_CWD ?? process.env.HOME!
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

Tables render but do not wrap: on a phone anything past the first couple of
narrow columns is cut off behind a scrollbar. Use one only for short enumerable
values, and put explanations in prose around it rather than in a wide cell.

Write for a phone: lead with the outcome and keep it to a few lines. Long
replies are split across several QQ messages, which is unpleasant to read.

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

type SDKUserMessage = {
  type: 'user'
  message: { role: 'user'; content: string }
  parent_tool_use_id: null
  session_id?: string
}

class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private waiting: ((m: SDKUserMessage) => void)[] = []
  private buffered: SDKUserMessage[] = []

  push(text: string): void {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
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
        const { keyboard, useLetters } = buildAskKeyboard(id, options)

        const lines = [`**${question}**`, '']
        if (useLetters) {
          // Buttons only carry the letter at this length, so the text must
          // carry the meaning or the choice is unreadable on a phone.
          options.forEach((opt, i) => lines.push(`${LETTERS[i]}：${opt}`))
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
      `你还没有获得授权。\n配对码：${code}\n请在本机运行：bun run pair.ts ${code}\n（10 分钟内有效）`,
      msg.id,
    )
    return
  }

  currentUser = msg.openid
  lastInboundMsgId.set(msg.openid, msg.id)

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

  const parts = [msg.content]
  for (const att of msg.attachments) {
    if (!att.url) continue
    parts.push(`[${att.content_type?.includes('image') ? '图片' : '文件'}] ${att.url}`)
  }
  queue.push(parts.join('\n'))
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

// ------------------------------------------------------------------ main loop

async function main(): Promise<void> {
  if (!HAS_CREDENTIALS) {
    log('QQ_APP_ID / QQ_CLIENT_SECRET missing — run: bun run onboard.ts')
    process.exit(1)
  }

  await connectGateway({ onMessage: handleMessage, onButton: handleButton })
  log(`bridge up, workdir=${WORKDIR}, state=${STATE_DIR}`)

  const q = query({
    prompt: queue,
    options: {
      systemPrompt: { type: 'preset', preset: 'claude_code', append: OPERATOR_CONTEXT },
      cwd: WORKDIR,
      permissionMode: 'default',
      // The terminal question tool has no UI here — nobody is watching a
      // terminal. Left enabled it renders into the void and comes back
      // unanswered. mcp__qq__qq_ask is its replacement.
      disallowedTools: ['AskUserQuestion'],
      canUseTool: async (toolName: string, input: Record<string, unknown>) => {
        const allow = await askApproval(toolName, input)
        return allow
          ? { behavior: 'allow' as const, updatedInput: input }
          : { behavior: 'deny' as const, message: '操作者在 QQ 上拒绝了这次调用' }
      },
      mcpServers: { qq: qqTools },
    } as any,
  })

  let lastProgressAt = 0
  const pendingTools: string[] = []

  for await (const message of q as any) {
    const m = message as any

    if (m.type === 'assistant') {
      for (const block of m.message?.content ?? []) {
        if (block.type === 'text' && block.text.trim()) {
          try {
            const user = requireUser()
            await sendToQQ(user, block.text.trim(), lastInboundMsgId.get(user))
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

process.on('SIGINT', () => {
  closeGateway()
  process.exit(0)
})
process.on('SIGTERM', () => {
  closeGateway()
  process.exit(0)
})

await main()
