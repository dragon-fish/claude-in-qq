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
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
 * arguments, and what the shell printed back. `balanced` keeps only its
 * shape: that thinking is happening, and which tools went by. `off` is the
 * answer alone.
 *
 * None of these levels is what tells the operator the agent is alive — QQ
 * blinks a caret on a message whose stream is still open, and marks the bot
 * offline when the connection drops. Both are free and neither can lie about
 * the process being gone. These levels are only about how much detail is
 * worth the screen.
 */
type TraceLevel = 'full' | 'balanced' | 'off'
let traceLevel: TraceLevel = 'full'

const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000
const QUESTION_TIMEOUT_MS = 15 * 60 * 1000

/**
 * End the turn's growing message, so whatever comes next starts a new one.
 *
 * For a standalone message that is its own utterance rather than part of the
 * reply — a slash command's answer, a file, the shutdown notice. Those follow
 * what was said; leaving the stream open would have the reply above go on
 * growing after them. Cards with buttons are not in this group and deliberately
 * do not seal: see `beforeSend` in qq.ts.
 *
 * Returns whether there was anything to seal.
 *
 * Assigned per turn by `runSession`; a no-op between turns.
 */
let sealStream: () => Promise<boolean> = async () => false

/**
 * An inbound message is waiting to enter the conversation, and the stream open
 * above it should be sealed once it does.
 *
 * Deliberately not sealed on arrival. A queued message does not reach the model
 * when it is typed — Claude Code folds it in at the next tool-result boundary,
 * or at the end of the turn if no tool runs before then — and until that
 * happens the reply above is still answering the message before it. Cutting on
 * arrival severs a sentence mid-word, and the two halves then read as two
 * separate replies, neither of which answers the message now sitting between
 * them. That destroys the ordering the cut was meant to preserve.
 *
 * A bubble that goes on growing above the operator's words is the accepted
 * cost. It is one reply, still finishing what it had already started saying.
 *
 * Only armed when a stream is actually open, and cleared by `sealStream` so a
 * seal from any cause settles it. Both matter: left armed with nothing to cut,
 * it would fire on the *next* reply instead, severing that one at its first
 * tool result over a message it was already answering.
 */
let sealPending = false

/**
 * Whether a stream is open right now. Assigned per turn by `runSession`;
 * between turns there is nothing open, so the default is the honest answer.
 */
let streamOpen: () => boolean = () => false

/**
 * Appended to Claude Code's own system prompt. Without it the agent assumes a
 * terminal it can print to and a human watching it, and both assumptions are
 * wrong here.
 *
 * It lives in its own file because it is the part of this bridge most often
 * edited, and the one part that cannot be swapped in place: the SDK's Query
 * exposes setModel and setPermissionMode but nothing for the system prompt,
 * and rewriting it mid-session would throw away the whole prefix cache. So a
 * running session keeps the text it started with, and an edit reaches it as a
 * reminder riding along with the next message instead.
 */
const CONTEXT_FILE = fileURLToPath(new URL('./operator-context.md', import.meta.url))

const readOperatorContext = () => readFileSync(CONTEXT_FILE, 'utf8').trim()
const contextMtime = () => statSync(CONTEXT_FILE).mtimeMs

const OPERATOR_CONTEXT = readOperatorContext()

/**
 * The mtime the live session's system prompt was read from.
 *
 * Deliberately not persisted: a restart re-reads the file, so a fresh process
 * is never behind and has nothing to catch up on.
 */
let seenContextMtime = contextMtime()

/**
 * The operator context as it stands now, if it changed under a running session.
 *
 * Returns the whole text rather than a diff. A diff would have to be applied
 * against a prompt the agent cannot re-read, and edits are rare enough that
 * paying for the full text once beats the ambiguity.
 */
function drainContextChange(): string | null {
  const now = contextMtime()
  if (now === seenContextMtime) return null
  seenContextMtime = now
  log('operator context changed on disk; folding it into the next message')
  return readOperatorContext()
}

/**
 * When this process started, if it started on top of a conversation that was
 * already running. Null when there was nothing to come back to.
 *
 * The agent cannot notice this on its own. A resumed session reads as unbroken
 * — the transcript is all there — so nothing in it says that the process
 * holding the other end died, and the agent goes on believing that work it had
 * in flight is still in flight. Restarts are frequent here, since the bridge is
 * often what is being edited.
 *
 * Armed once at startup, deliberately not per session: `runSession` also reruns
 * for /clear and /cwd, and neither of those is a restart. A missing session_id
 * means either a first run or a /clear, and in both the conversation starts
 * from nothing — there is no earlier state to warn about.
 *
 * Set by `main`; drained into the first message that follows.
 */
type RestartNotice = {
  at: number
  /** When the previous process stopped, or null if it never said goodbye. */
  stoppedAt: number | null
  /**
   * The signal it stopped on, `crash` for an uncaught exception, or null for a
   * death that ran no handler at all — SIGKILL, the OOM killer, loss of power.
   *
   * unhandledRejection is deliberately not among these. Registering a listener
   * for it suppresses whatever the runtime would have done, so recording it
   * would mean also deciding whether to exit — and getting that wrong invents
   * crashes in a process that used to survive. It lands in the null case.
   */
  signal: string | null
  /** What the exception said, for a crash. */
  error: string | null
  /** Whether the machine itself rebooted while the bridge was down. */
  rebooted: boolean
}

let restartNotice: RestartNotice | null = null

function drainRestartNotice(): RestartNotice | null {
  const notice = restartNotice
  restartNotice = null
  return notice
}

/** A duration in words, for a gap nobody wants to read in milliseconds. */
function spokenGap(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟`
  return `${(ms / 3_600_000).toFixed(1)} 小时`
}

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
  const context = drainContextChange()
  const restarted = drainRestartNotice()
  if (!commandLog.length && !relayed.length && !context && !restarted) return text

  const hhmm = (at: number) =>
    new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

  const lines: string[] = []

  // First: it is the rules the rest of the turn is read under.
  if (context) {
    lines.push(
      '你的 operator context 在上一轮之后被改过了。以下是当前全文，取代此前的任何版本' +
        '——包括系统提示词里的那一份，那是本 session 开始时的快照：',
    )
    lines.push(`<system-reminder>\n${context}\n</system-reminder>`)
  }

  // Second: it explains a gap the transcript does not show.
  if (restarted) {
    const how =
      restarted.signal === 'crash'
        ? `上一个进程在 ${hhmm(restarted.stoppedAt!)} 抛出未捕获异常崩溃` +
          (restarted.error ? `：${restarted.error}` : '')
        : restarted.signal === 'SIGINT'
          ? `上一个进程在 ${hhmm(restarted.stoppedAt!)} 收到 SIGINT 退出，是终端里被 Ctrl-C`
          : restarted.signal
            ? `上一个进程在 ${hhmm(restarted.stoppedAt!)} 收到 ${restarted.signal} 正常退出，` +
              '通常是 launchd 在重启这个服务——多半有人刚改过它'
            : '上一个进程没有走任何退出流程，是被强杀（SIGKILL）、OOM，或者机器直接断了'
    const down = restarted.stoppedAt
      ? `，停了 ${spokenGap(restarted.at - restarted.stoppedAt)}`
      : ''
    const reboot = restarted.rebooted ? '这台机器在此期间重启过。' : ''
    lines.push(
      '<system-reminder>\n' +
        `claude-in-qq 这个桥接进程在 ${hhmm(restarted.at)} 重启过，本 session 是从磁盘 resume 回来的。` +
        `${how}${down}。${reboot}\n` +
        '上下文接得回来，进程里的状态接不回来——重启那一刻正在跑的工具调用、还没答复的审批和提问、' +
        '没发完的回复，都不会有结果了。若你记得自己在等什么，那件事已经不在了。\n' +
        '</system-reminder>',
    )
  }

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
/**
 * `render` is kept alongside the options because a page turn re-posts the same
 * question: the layout mode can change with the page, so the body has to be
 * rebuilt rather than remembered as a finished string.
 */
const pendingQuestions = new Map<
  string,
  Pending<string> & {
    options: string[]
    render: (mode: AskLayout['mode']) => string
    /**
     * True when only a button press may answer this. A command that lists
     * choices is not waiting on the operator — the agent is not blocked, and
     * the next thing typed is far more likely to be a new instruction than a
     * late answer. Claiming it strands both: the choice matches nothing and
     * the sentence never reaches the agent.
     */
    buttonsOnly?: boolean
  }
>()

/**
 * Post a question and its keyboard. Called again, with the same id, when the
 * operator turns a page — the pending promise is untouched, only the message
 * showing the choices is new.
 */
async function postQuestion(
  user: string,
  id: string,
  options: string[],
  render: (mode: AskLayout['mode']) => string,
  page = 0,
): Promise<void> {
  const layout = buildAskKeyboard(id, options, page)
  const body =
    layout.pages > 1
      ? `${render(layout.mode)}\n\n第 ${layout.page + 1}/${layout.pages} 页`
      : render(layout.mode)
  await sendToQQ(user, body, lastInboundMsgId.get(user), layout.keyboard)
}

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

        const render = (mode: AskLayout['mode']) => {
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
          return lines.join('\n')
        }

        await postQuestion(user, id, options, render)

        const answer = await new Promise<string>(resolve => {
          const timer = setTimeout(() => {
            pendingQuestions.delete(id)
            resolve('(操作者未在 15 分钟内回答)')
          }, QUESTION_TIMEOUT_MS)
          pendingQuestions.set(id, { resolve, timer, options, render })
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
const PAGE_BUTTON_RE = /^ask:([a-km-z]{5}):p(\d+)$/

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
  // to a newer one, so the reply above goes on growing over the operator's
  // words until it is sealed. Arm the seal rather than performing it: see
  // `sealPending` for why the cut belongs at the moment the message actually
  // enters the conversation and not at the moment it arrives.
  //
  // Paths that never reach the agent need no special case. A slash command is
  // answered from here with an ordinary message, and every ordinary message
  // seals on its way out through the `onBeforeSend` invariant — so its answer
  // still lands below, and below a reply that was left whole.
  sealPending = streamOpen()

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

  // Only a question that is genuinely waiting on words may claim this message.
  // One raised by a command keeps its buttons live and lets the text through,
  // so `/model` followed by an unrelated sentence answers neither — the
  // sentence reaches the agent, and the buttons stay clickable until they
  // time out. Passing an argument stays possible the obvious way: /model sonnet.
  const answering = [...pendingQuestions.entries()].find(([, q]) => !q.buttonsOnly)
  if (answering) {
    const [id, q] = answering
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

  const turn = PAGE_BUTTON_RE.exec(buttonData)
  if (turn) {
    const q = pendingQuestions.get(turn[1])
    if (!q) {
      log(`page turn for unknown or expired question ${turn[1]}`)
      return
    }
    // A new message rather than an edit: QQ has no way to rewrite a keyboard in
    // place, and the question stays open either way.
    await postQuestion(openid, turn[1], q.options, q.render, Number(turn[2]))
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
  /**
   * When the previous process last shut down cleanly, and on what signal.
   *
   * Written by the signal handler, so their *absence* is the interesting case:
   * a process that died without running it was killed outright or crashed.
   * Read and cleared at startup, or a later restart would report this one.
   */
  stopped_at?: number | null
  stopped_by?: string | null
  /** What the exception said, when `stopped_by` is `crash`. */
  stopped_error?: string | null
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
  buttonsOnly = false,
): Promise<number> {
  const user = requireUser()
  const id = randomId()

  await postQuestion(user, id, options, renderBody)

  const answer = await new Promise<string>(resolve => {
    const timer = setTimeout(() => {
      pendingQuestions.delete(id)
      resolve('')
    }, QUESTION_TIMEOUT_MS)
    pendingQuestions.set(id, { options, resolve, timer, render: renderBody, buttonsOnly })
  })
  return options.indexOf(answer)
}

/** Everything the command layer is allowed to touch, and nothing more. */
function commandDeps(user: string): CommandDeps {
  return {
    reply: text => sendToQQ(user, text, lastInboundMsgId.get(user)),
    askChoice: (options, render) => askChoice(options, render, true),
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
  /**
   * Blank lines held back rather than sent, because QQ rejects a message whose
   * content is only whitespace. They are prepended to the next write that has
   * something in it.
   *
   * Do not go back to dropping them. A run of newlines can arrive as a flush of
   * its own — the closing ``` ends a delta, the newlines start the next one —
   * and discarding it welds the text on either side together: a closing fence
   * and the line after it come out as ````, which swallows the rest of the
   * reply into the code block.
   */
  private pendingBlank = ''

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
    // release immediately — the transport coalesces on its own clock, so
    // holding text back here only makes that clock arrive with nothing to
    // send. Twelve characters was the old threshold, and at typical generation
    // speed it filled roughly once every quarter second: the reply advanced a
    // dozen characters at a time, in visible steps, no matter how the
    // transport was tuned.
    //
    // Inside a fence there is nothing to gain either way: released mid-line, a
    // thinking summary twitches forward a few characters at a time in a box
    // the eye is already skimming. Whole lines only.
    if (this.channel === 'prose' && this.buffer && !this.mightBeMedia()) {
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
    if (next === 'trace') {
      // The reply may itself be inside a code block — showing code is a normal
      // thing to do. Opening the trace block without closing that one first
      // means the trace's own fence closes the reply's block instead, and
      // every fence after it lands on the wrong side. Suspend it, and reopen
      // it on the way back with the language it was written with.
      // Through writeFence, which puts it on a line of its own. Written by
      // hand it landed against the end of whatever the reply had just said,
      // and a fence that does not start its line is not a fence at all — it
      // is inline-code punctuation, so the block it was meant to close stayed
      // open and everything after it nested one level too deep.
      if (this.proseFence !== null) await this.writeFence(false)
      await this.writeFence(true)
    } else {
      await this.writeFence(false)
      if (this.proseFence !== null) {
        this.writeThrough(`${this.atStreamLineStart ? '' : '\n'}\`\`\`${this.proseFence}\n`)
      }
    }
    // Blank lines do not carry across a fence; the fence writers place their
    // own newlines.
    this.pendingBlank = ''
    this.channel = next
  }

  /**
   * The info string of the reply's own open code block, or null when the reply
   * is not inside one. Tracked because the trace has to step around it.
   */
  private proseFence: string | null = null

  /** Update `proseFence` for one line of the reply. */
  private trackProseFence(line: string): void {
    const fence = /^ {0,3}(`{3,}|~{3,})\s*(.*)$/.exec(line.replace(/\n$/, ''))
    if (!fence) return
    if (this.proseFence === null) this.proseFence = fence[2].trim()
    else this.proseFence = null
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
    this.writeThrough(`${lead}\`\`\`${open ? LineStreamer.TRACE_LANG : ''}\n`)
  }

  private static readonly TRACE_LANG = 'text'

  /**
   * Write straight through, skipping the line buffer — for text that has to
   * appear now rather than when a line happens to end. A tool name in
   * `balanced` mode is one: its line stays open so the next name can be
   * appended to it, so there is no newline coming to flush it.
   *
   * Refuses when a line is half-written, rather than cutting in: a dot in the
   * middle of a sentence is worse than a late dot, and the next tick will find
   * a better moment.
   */
  async pushNow(text: string, channel: Channel): Promise<boolean> {
    // Order matters. Switching channels flushes whatever is buffered on the
    // way out, so checking first would refuse exactly the case that needs
    // this most: a tool called mid-sentence, where the unfinished prose line
    // is sitting in the buffer with no newline coming to release it. Both the
    // half-line and the tool name would be held until the tool returned.
    if (channel !== this.channel) await this.switchTo(channel)
    if (this.buffer) return false
    this.writeThrough(text)
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

  /**
   * Flush the trailing partial line, close the stream, and post any overflow.
   *
   * Returns the info string of a code fence the reply was still inside, for
   * the next message to reopen, or null when it ended outside one.
   */
  async finish(): Promise<string | null> {
    if (this.buffer) {
      const rest = this.buffer
      const wasAtStart = this.atLineStart
      this.buffer = ''
      await this.emit(rest, wasAtStart)
    }
    // Trailing blank lines are not worth a message of their own.
    this.pendingBlank = ''
    // A code block the reply opened is not finished, only interrupted. Handed
    // back so the next message can pick it up; see resumeProseFence.
    const carried = this.proseFence
    // A turn that ends mid-trace — interrupted, or one that never got round to
    // an answer — would otherwise leave the fence open and swallow whatever the
    // next message renders beneath it. On the way into the trace block the
    // reply's own fence was already closed, so there is only ever one to close.
    if (this.channel === 'trace') {
      await this.writeFence(false)
      this.channel = 'prose'
    } else if (carried !== null) {
      this.writeThrough(`${this.atStreamLineStart ? '' : '\n'}\`\`\`\n`)
    }
    this.proseFence = null
    // Everything above was queued, not sent. Closing the stream out from under
    // the drain would end the message before its last batches reached it, and
    // the overflow below is only whole once the drain has had its say.
    await this.settle()
    await this.stream?.end()
    this.stream = null
    if (this.overflow.trim()) {
      const rest = this.overflow
      this.overflow = ''
      await this.sendText(rest.trim())
    }
    return carried
  }

  /**
   * Reopen a code fence the previous message was cut inside of.
   *
   * A fence belongs to one message and does not survive into the next, but the
   * seal that ends a message can land anywhere — a tool result arrives while
   * the reply is halfway through quoting a log. Left alone, the old message
   * ends unterminated and the reply's own closing fence, now the first one in a
   * fresh message, reads as an *opening* fence and swallows everything after
   * it. Both halves render wrong, which is worse than either alone.
   */
  resumeProseFence(info: string): void {
    this.proseFence = info
    this.writeThrough(`\`\`\`${info}\n`)
  }

  /**
   * Text handed over but not yet carried by a request.
   *
   * An append is one HTTP round trip and they cannot overlap, so a reply that
   * generates faster than they return will outrun them. Waiting for each one
   * pinned the whole loop to that rate: 144 requests for 419 characters, under
   * three characters a request, and a tail that reached the phone half a minute
   * after the model had stopped writing.
   *
   * So the handover does not wait. Deltas arriving behind an in-flight request
   * pile up here and the next request carries all of them at once. Nothing is
   * batched when nothing is waiting — a reply slower than the round trip still
   * goes out a delta at a time — and a batch is never larger than the backlog
   * that produced it, so this cannot add latency of its own.
   *
   * Do not turn this back into an awaited write, and do not reach for a fixed
   * throttle instead. That was tried: it coarsens every step whether or not
   * anything is waiting, which reads as stuttering.
   */
  private queued = ''

  /** The drain currently running, or null once everything has landed. */
  private draining: Promise<void> | null = null

  /**
   * Hand text to the transport. Returns once it is queued, not once it is sent.
   *
   * The single place `atStreamLineStart` is maintained, so a fence always lands
   * on its own line. It tracks what has been handed over rather than what has
   * been delivered, because the decisions that read it are made while writing.
   */
  private writeThrough(chunk: string): void {
    if (!chunk) return
    this.queued += chunk
    this.atStreamLineStart = chunk.endsWith('\n')
    this.draining ??= this.drain()
  }

  /** Carry the queue to QQ, a request at a time, until it is empty. */
  private async drain(): Promise<void> {
    try {
      while (this.queued) {
        const chunk = this.queued
        this.queued = ''
        await this.deliver(chunk)
      }
    } catch (err) {
      // Losing the drain must not take down the turn producing the text; the
      // rest of the reply still has finish() and its overflow to land in.
      log('stream drain failed:', err)
    } finally {
      this.draining = null
    }
  }

  /**
   * Wait for everything handed over so far to reach QQ.
   *
   * Only ever from the producing side. `deliver` and what it calls — rollStream,
   * reopen — already run inside the drain, and waiting on it from in there
   * would be waiting for itself.
   */
  private async settle(): Promise<void> {
    while (this.draining) await this.draining
  }

  /**
   * Hand one batch to the open stream, opening one on first use and diverting
   * to `overflow` once QQ has refused.
   */
  private async deliver(chunk: string): Promise<void> {
    if (this.stream?.full) await this.rollStream()
    this.stream ??= this.open()
    // QQ ends a stream from its own side, and has more than one way to say so:
    // 40034020 is a documented time limit, seen once at ten minutes, and
    // 40034019 reports the guide simply over. Carry on in a fresh message
    // rather than holding the rest back until finish() — that wait is what
    // reads as the bridge having hung mid-sentence.
    if (this.stream.failed && !this.stream.exhausted) await this.reopen()
    if (this.stream.failed) {
      // Out of passive quota, so there is no new stream to be had. Hold it
      // back rather than drop it; finish() posts it as a normal message so
      // nothing is lost and nothing already on screen gets repeated.
      this.overflow += chunk
      return
    }
    await this.stream.write(chunk)
    // The write that trips the failure is already counted in the stream's own
    // `full`, but it never left the process. Treating it as delivered is how a
    // line goes missing across the seam between two messages.
    if (this.stream.failed) {
      if (!this.stream.exhausted) {
        await this.reopen()
        if (!this.stream.failed) await this.stream.write(chunk)
      }
      // Checked again, because the replacement can fail on its own first write
      // just as easily — or be born failed once passive quota is gone. The
      // chunk still has to land somewhere, and overflow is the last place left.
      if (this.stream.failed) this.overflow += chunk
    }
  }

  /**
   * Replace a stream QQ has ended with its successor.
   *
   * rollStream only reopens on the trace channel, where the fence has to be
   * reinstated; on prose it leaves the slot empty for the next write to fill
   * lazily, which is too late for a caller that is about to read `failed`.
   *
   * Passive quota is what keeps this from looping: four uses per inbound
   * message, and once they are gone `open()` hands back a stream that has
   * already failed, which falls through to overflow exactly as before.
   */
  private async reopen(): Promise<void> {
    await this.rollStream()
    this.stream ??= this.open()
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
        this.writeThrough(text.replace(/`{2,}/g, m => `\`${'｀'.repeat(m.length - 1)}`))
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
      if (!chunk) return
      if (!chunk.trim()) {
        this.pendingBlank += chunk
        return
      }
      this.writeThrough(this.pendingBlank + chunk)
      this.pendingBlank = ''
    }

    // Keeping the newline with its line, so a split never loses one.
    for (const line of text.split(/(?<=\n)/)) {
      const atStart = lineStart
      const media = atStart ? /^MEDIA:[ \t]*(\S.*?)[ \t]*$/.exec(line.replace(/\n$/, '')) : null
      lineStart = line.endsWith('\n')
      // Only whole lines: a fence is a line, and half of one released early
      // by the chunker would read as an opening fence with a truncated info
      // string.
      if (atStart && lineStart) this.trackProseFence(line)
      if (!media) {
        prose += line
        continue
      }
      // A file interrupts the stream: the text before it is finished and sent,
      // the attachment goes out, and what follows starts a new one. That is what
      // puts the picture where the writing referred to it, instead of stacking
      // every image after the prose has ended.
      await flush()
      // flush only queued it. The picture may not overtake the words that
      // introduce it, so the drain has to finish before the message closes.
      await this.settle()
      await this.stream?.end()
      this.stream = null
      this.atStreamLineStart = true
      // Whatever was being held belonged to the text before the attachment.
      this.pendingBlank = ''
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

  /**
   * A code fence the message just sealed was cut inside of, for the next one to
   * reopen. Now that a seal can land mid-turn, it lands mid-code-block often —
   * the reply quotes a log, a tool result comes back partway through it.
   */
  let carriedFence: string | null = null

  async function closeStreamer(): Promise<boolean> {
    // Settled either way: with no stream open there is nothing left for a
    // pending seal to wait for, and leaving it armed would cut the *next*
    // reply at its first tool result for no reason.
    sealPending = false
    // The trace block does not survive the stream that held it. Whatever opens
    // next starts on an empty one, so the bookkeeping that decides whether an
    // entry is already there — and how its last line ended — has to start
    // empty too, or the new block opens with a separator before its first line.
    traceStarted = false
    traceTail = ''
    lastKind = null
    if (!streamer) return false
    const s = streamer
    streamer = null
    try {
      carriedFence = await s.finish()
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
  streamOpen = () => streamer !== null


  /** Which content block the deltas currently belong to. */
  let block: string | null = null
  /** tool_use id → name, so a result can be matched to the call that made it. */
  const toolNames = new Map<string, string>()

  function newStreamer(): LineStreamer {
    const s = new LineStreamer(
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
    // Before anything else reaches it, so the reopened fence is the first thing
    // in the message and the text that was cut off resumes inside it.
    if (carriedFence !== null) {
      s.resumeProseFence(carriedFence)
      carriedFence = null
    }
    return s
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
        } else if (block === 'thinking' && traceLevel === 'balanced') {
          // One entry per stretch of thinking, not per block. The line is left
          // open and extended in place, so a long stretch reads as one thing
          // still going rather than as a stack of identical lines.
          if (lastKind === 'thinking') {
            await traceNow('仍在思考……')
          } else {
            await traceEndLine()
            await traceNow('💭 思考中……')
            traceStarted = true
            lastKind = 'thinking'
          }
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
              await traceEndLine()
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
      let sawToolResult = false
      for (const b of m.message?.content ?? []) {
        if (b.type !== 'tool_result') continue
        sawToolResult = true
        const name = toolNames.get(b.tool_use_id)
        toolNames.delete(b.tool_use_id)
        if (!name || traceLevel !== 'full') continue
        const out = summariseResult(name, b.content)
        if (out) await trace(`${out}\n`)
      }

      // Where a message the operator sent mid-turn actually joins the
      // conversation. Claude Code drains its queue once a batch of tool calls
      // has all reported, just before the next model call, and folds the text
      // in as an attachment — the API refuses a plain user message interleaved
      // among tool results, so no other point in a turn can take one.
      //
      // Nothing on the stream announces it: the attachment is never emitted,
      // and these tool results are the only visible trace of the boundary it
      // rides on. `toolNames` empties exactly when the last outstanding call
      // reports, which is that boundary. Waiting for it matters when calls run
      // in parallel — cutting at the first result of a batch would cut while
      // the others are still running, and a slow one makes that minutes early.
      //
      // A call that never reports leaves the map full and the seal unfired;
      // the turn's `result` catches it.
      //
      // After the summaries, not before. Those describe work that finished
      // ahead of the operator's message, so they belong to the stream above.
      if (sawToolResult && sealPending && toolNames.size === 0) await closeStreamer()
    } else if (m.type === 'result') {
      // Where the stream closes when nothing closed it earlier. A turn can also
      // end without a final assistant message (interrupt, error), and this
      // catches that too rather than leaving it half-written. The trace
      // bookkeeping is reset by closeStreamer itself.
      await closeStreamer()
      block = null
      streamedText = false
      // A fence is only carried across a seal inside one reply. A turn that
      // ended inside one left it unbalanced on its own, and reopening it over
      // the next turn's first words would spread one mistake across two.
      carriedFence = null
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

  // A session on disk means this process is picking up a conversation rather
  // than starting one, which the agent has no other way to find out.
  if (state.session_id) {
    const now = Date.now()
    const bootedAt = now - uptime() * 1000
    restartNotice = {
      at: now,
      stoppedAt: state.stopped_at ?? null,
      signal: state.stopped_by ?? null,
      error: state.stopped_error ?? null,
      // With a recorded stop, a boot after it settles the question. Without
      // one, coming up within a few minutes of boot is the tell — that is
      // launchd starting its jobs, not someone restarting this one.
      rebooted: state.stopped_at
        ? bootedAt > state.stopped_at
        : now - bootedAt < 5 * 60_000,
    }
    log(`resuming an existing session; previous stop: ${state.stopped_by ?? 'none recorded'}`)
  }
  // Cleared whether or not it was reported, so the next restart cannot inherit
  // this one's cause and describe a shutdown that already happened.
  if (state.stopped_at || state.stopped_by) {
    patchState({ stopped_at: null, stopped_by: null, stopped_error: null })
  }

  // Sealing before a standalone message, installed once. Cards with buttons are
  // exempt and take their own route — see `beforeSend` in qq.ts.
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
  // Recorded first. Everything below can be cut short by the grace timer or by
  // launchd losing patience, and the successor reads the *absence* of this as
  // "died without warning" — so it has to be on disk before anything can fail.
  patchState({ stopped_at: Date.now(), stopped_by: signal, stopped_error: null })
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

/**
 * Record a crash on the way out, then crash anyway.
 *
 * Registering a handler suppresses the default exit, so exiting here is what
 * keeps the behaviour the same as before — launchd sees a failure and restarts,
 * but now the successor can say what happened instead of reporting the death as
 * unexplained.
 *
 * unhandledRejection is deliberately left alone. Listening to it would also
 * suppress whatever the runtime does today, and guessing wrong there invents
 * crashes in a process that used to survive. Those land in the no-record case,
 * which reads as "no exit path ran" — true enough.
 */
process.on('uncaughtException', err => {
  log('uncaught exception:', err)
  try {
    patchState({
      stopped_at: Date.now(),
      stopped_by: 'crash',
      stopped_error: String((err as Error)?.message ?? err).slice(0, 200),
    })
  } catch {
    // Nothing left to do about it; the crash itself still has to happen.
  }
  process.exit(1)
})

await main()
