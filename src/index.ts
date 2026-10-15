#!/usr/bin/env bun
/**
 * Drive Claude Code from QQ private chat and QQ groups.
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
import { allCommands, buildHead, confirmRestart, dispatch, type CommandDeps } from './commands.js'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, uptime } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { History } from './history.js'
import { nativePath } from './paths.js'
import {
  commandText,
  describeMessage,
  mentionsMe,
  RECENT_IN_CONTEXT,
  renderMentions,
  routeGroupMessage,
  wrapTurn,
} from './turn.js'
import {
  addOp,
  type Attachment,
  buildApprovalKeyboard,
  buildAskKeyboard,
  type AskLayout,
  closeGateway,
  connectGateway,
  createGroupStream,
  createStream,
  type StreamHandle,
  drainRelayed,
  dropExpiredPending,
  fetchImage,
  groupReplyTarget,
  HAS_CREDENTIALS,
  isAllowed,
  isOp,
  isOwner,
  lastInboundMsgId,
  onGroupSent,
  rememberGroupInbound,
  rememberInbound,
  removeOp,
  LETTERS,
  loadAccess,
  log,
  MEDIA_LINE_RE,
  PAIRING_TTL_MS,
  randomId,
  saveAccess,
  sendFile,
  sendGroupFile,
  sendToGroup,
  sendToQQ,
  STATE_DIR,
  syncCommandPanel,
  onBeforeSend,
  type GroupMember,
  type InboundGroupMessage,
  type InboundMessage,
} from './qq.js'

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

const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000
const QUESTION_TIMEOUT_MS = 15 * 60 * 1000

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
 * The mtime `OPERATOR_CONTEXT` was read at, which is what every session this
 * process starts has in its system prompt. Each conversation tracks its own
 * catch-up from here, since each one's agent has to be told separately.
 *
 * Deliberately not persisted: a restart re-reads the file, so a fresh process
 * is never behind and has nothing to catch up on.
 */
const OPERATOR_CONTEXT_MTIME = contextMtime()

/**
 * The operator context as it stands now, if it changed under the
 * conversation's running session.
 *
 * Returns the whole text rather than a diff. A diff would have to be applied
 * against a prompt the agent cannot re-read, and edits are rare enough that
 * paying for the full text once beats the ambiguity.
 */
function drainContextChange(conv: Conversation): string | null {
  const now = contextMtime()
  if (now === conv.seenContextMtime) return null
  conv.seenContextMtime = now
  log(`[${conv.key}] operator context changed on disk; folding it into the next message`)
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
 * Built once at startup by `main` from how the previous process ended, and
 * armed on each conversation as it is opened — only if that conversation has a
 * session on disk to resume. A missing session_id means either a first run or
 * a /clear, and in both the conversation starts from nothing — there is no
 * earlier state to warn about. Deliberately not re-armed per session:
 * `runSession` also reruns for /clear and /cwd, and neither of those is a
 * restart.
 *
 * Drained into the first message that conversation receives.
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

let startupNotice: RestartNotice | null = null

function drainRestartNotice(conv: Conversation): RestartNotice | null {
  const notice = conv.restartNotice
  conv.restartNotice = null
  return notice
}

/** A duration in words, for a gap nobody wants to read in milliseconds. */
function spokenGap(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟`
  return `${(ms / 3_600_000).toFixed(1)} 小时`
}

/**
 * Whoever last wrote in privately. Single-operator by design; the allowlist
 * enforces it. Approvals and questions go here whichever conversation raised
 * them, and the private conversation's replies do too.
 */
let currentUser: string | null = null

/** The operator's openid, or null when nobody is allowlisted yet. */
function operatorOpenid(): string | null {
  return currentUser ?? loadAccess().allowed[0] ?? null
}

function requireUser(): string {
  const user = operatorOpenid()
  if (!user) throw new Error('no allowlisted QQ user to talk to')
  return user
}

// ------------------------------------------------------------- message stream
//
// query() consumes an AsyncIterable, so inbound QQ messages are pushed into a
// queue — one per conversation — and pulled by the SDK as it advances.

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

/**
 * A slash command the operator ran since the agent last heard from them.
 *
 * The bridge handles commands entirely on its own — the agent never sees the
 * command, its arguments, or its output. Left unsaid, that produces an agent
 * reasoning about a working directory that moved, or one that believes it
 * finished work the operator interrupted. Even a command with no side effect is
 * a signal worth passing on: someone reading /help is working out what this
 * thing can do.
 */
type CommandRecord = { name: string; args: string; at: number; note?: string }

// -------------------------------------------------------------- conversations
//
// One conversation is one chat with its own agent session: its own query,
// queue, streamer, session id, workdir, permission mode and trace level. Two of
// them never share a stream or a session, so they can run side by side. The
// private chat is one; each group is another, opened on its first trigger.
//
// Process-wide, and deliberately not on a conversation: the QQ gateway and
// passive quota, the allowlist and op list, group history, approvals and
// questions (always posted to the operator's private chat, tagged with the
// conversation that raised them), the wake note (delivered to the private
// conversation), crash bookkeeping, and shutdown.

/**
 * The operator's private chat. One key, not one per openid: the bridge is
 * single-operator, and every allowlisted sender shares this session and gets
 * its replies — keying it by sender would split that session in two.
 */
const PRIVATE_KEY = 'c2c'

/**
 * Where a conversation's output goes. Every send resolves its target and the
 * inbound message it replies to at the moment it is made, so a reply follows
 * the newest message rather than the one the turn started on.
 */
type Chat = {
  send(text: string): Promise<void>
  sendFile(path: string, caption?: string): Promise<void>
  openStream(): StreamHandle
  /** The inbound message replies currently attach to, for the log. */
  replyTo(): string | undefined
  /** Whether a standalone message to this openid lands in this chat. */
  owns(openid: string): boolean
}

/** Group conversations are keyed by this plus the group_openid. */
const GROUP_PREFIX = 'group:'

const groupKey = (group: string) => `${GROUP_PREFIX}${group}`

/** The group a conversation belongs to, or null for the private one. */
function groupOf(conv: Conversation): string | null {
  return conv.key.startsWith(GROUP_PREFIX) ? conv.key.slice(GROUP_PREFIX.length) : null
}

const privateChat: Chat = {
  send: text => {
    const user = requireUser()
    return sendToQQ(user, text, lastInboundMsgId.get(user))
  },
  sendFile: (path, caption) => {
    const user = requireUser()
    return sendFile(user, path, lastInboundMsgId.get(user), caption)
  },
  openStream: () => {
    const user = requireUser()
    return createStream(user, lastInboundMsgId.get(user))
  },
  replyTo: () => {
    const user = operatorOpenid()
    return user ? lastInboundMsgId.get(user) : undefined
  },
  owns: openid => openid === operatorOpenid(),
}

/**
 * A group's output. No streaming — QQ takes no stream parameters for groups —
 * so a turn's text is collected and posted when the streamer seals it; see
 * createGroupStream. Each post is passive on the newest group message that
 * still has a use left, and active otherwise.
 *
 * Text QQ refuses goes to the owner's private chat rather than nowhere.
 */
function groupChat(group: string): Chat {
  const undelivered = (text: string, err: unknown) => forwardUndelivered(group, text, err)
  return {
    send: async text => {
      try {
        await sendToGroup(group, text)
      } catch (err) {
        await undelivered(text, err)
      }
    },
    sendFile: (path, caption) => sendGroupFile(group, path, caption),
    openStream: () => createGroupStream(group, undelivered),
    replyTo: () => groupReplyTarget(group),
    owns: id => id === group,
  }
}

async function forwardUndelivered(group: string, text: string, err: unknown): Promise<void> {
  const owner = operatorOpenid()
  if (!owner) {
    log(`group ${group.slice(0, 8)}: reply undeliverable and no owner to forward it to`)
    return
  }
  const about = conversations.get(groupKey(group))?.lastTrigger
  await sendToQQ(
    owner,
    `⚠️ 群 \`${group}\` 的回复没能发出（${String(err).slice(0, 120)}），转到这里。` +
      `${about ? `\n回复的是：${about}` : ''}\n\n${text}`,
    lastInboundMsgId.get(owner),
  )
}

class Conversation {
  readonly key: string
  readonly chat: Chat

  /**
   * Mutable and persisted. A value chosen with /cwd or /mode outranks the env
   * default: it is the operator's most recent explicit decision, and the env
   * var only describes how this process happened to be launched.
   *
   * A new group starts in the home directory with no trace: `QQ_BRIDGE_CWD`
   * describes the operator's own session, and every trace line in a group is
   * read by everyone in it.
   */
  workdir: string
  permissionMode: string
  traceLevel: TraceLevel

  /** The live query, or null before the first message starts a session. */
  query: any = null
  /** Set when a command needs the query torn down and rebuilt. */
  restartReason: string | null = null

  /**
   * Kept across this conversation's sessions: a message typed while /cwd
   * rebuilds the query waits here for the next one.
   */
  readonly queue = new MessageQueue()

  /**
   * End the turn's growing message, so whatever comes next starts a new one.
   *
   * Ordering in QQ is positional, so anything sent as its own message — a
   * slash command's answer, an approval card, a question, a file — lands below
   * a stream that would otherwise go on growing above it. Sealing first puts
   * the reply underneath the thing it is replying to, where it happened.
   *
   * Returns whether there was anything to seal.
   *
   * Assigned per session by `runSession`; a no-op before the first one.
   */
  sealStream: () => Promise<boolean> = async () => false

  /**
   * An inbound message is waiting to enter the conversation, and the stream
   * open above it should be sealed once it does.
   *
   * Deliberately not sealed on arrival. A queued message does not reach the
   * model when it is typed — Claude Code folds it in at the next tool-result
   * boundary, or at the end of the turn if no tool runs before then — and until
   * that happens the reply above is still answering the message before it.
   * Cutting on arrival severs a sentence mid-word, and the two halves then read
   * as two separate replies, neither of which answers the message now sitting
   * between them. That destroys the ordering the cut was meant to preserve.
   *
   * A bubble that goes on growing above the operator's words is the accepted
   * cost. It is one reply, still finishing what it had already started saying.
   *
   * Only armed when a stream is actually open, and cleared by `sealStream` so
   * a seal from any cause settles it. Both matter: left armed with nothing to
   * cut, it would fire on the *next* reply instead, severing that one at its
   * first tool result over a message it was already answering.
   *
   * This is one of the two rules that decide where a message ends, one per
   * direction. Outbound is `beforeSend` in qq.ts: anything not written into the
   * open stream seals it on the way out, enforced at the transport so a sender
   * added later inherits it. Inbound is this: the seal waits for the moment the
   * message actually reaches the model. Answering a card is an inbound message
   * that happens to arrive as a tool result, and needs nothing of its own —
   * posting the card already sealed under the outbound rule.
   */
  sealPending = false

  /**
   * Whether a stream is open right now. Assigned per session by `runSession`;
   * before it there is nothing open, so the default is the honest answer.
   */
  streamOpen: () => boolean = () => false

  /** Slash commands run here since the agent last heard from the operator. */
  readonly commandLog: CommandRecord[] = []

  /** The operator-context mtime this conversation's agent has last been shown. */
  seenContextMtime = OPERATOR_CONTEXT_MTIME

  /** See `RestartNotice`. */
  restartNotice: RestartNotice | null

  /**
   * Groups only: who said what to start the latest turn, quoted when a reply
   * has to be forwarded to the owner instead of landing in the group.
   */
  lastTrigger: string | null = null

  /**
   * This conversation's own instance of the bridge's tools, so a question the
   * agent asks is recorded against the conversation that asked it.
   */
  readonly tools: ReturnType<typeof createSdkMcpServer>

  constructor(key: string, chat: Chat) {
    this.key = key
    this.chat = chat
    const saved = loadConversationState(key)
    const isGroup = key !== PRIVATE_KEY
    this.workdir = saved.workdir ?? (isGroup ? homedir() : (process.env.QQ_BRIDGE_CWD ?? homedir()))
    this.permissionMode = saved.permission_mode ?? process.env.QQ_PERMISSION_MODE ?? 'auto'
    this.traceLevel = saved.trace_level ?? (isGroup ? 'off' : 'full')
    this.restartNotice = saved.session_id ? startupNotice : null
    this.tools = qqToolsFor(this)
  }

  sessionId(): string | null {
    return loadConversationState(this.key).session_id ?? null
  }

  setSessionId(id: string | null): void {
    patchConversationState(this.key, { session_id: id })
  }

  setWorkdir(path: string): void {
    this.workdir = path
    patchConversationState(this.key, { workdir: path })
  }

  setPermissionMode(mode: string): void {
    this.permissionMode = mode
    patchConversationState(this.key, { permission_mode: mode })
  }

  setTraceLevel(level: TraceLevel): void {
    this.traceLevel = level
    patchConversationState(this.key, { trace_level: level })
  }
}

const conversations = new Map<string, Conversation>()

/** The conversation for `key`, opened from its persisted state on first use. */
function openConversation(key: string, chat: Chat): Conversation {
  let conv = conversations.get(key)
  if (!conv) {
    conv = new Conversation(key, chat)
    conversations.set(key, conv)
  }
  return conv
}

function privateConversation(): Conversation {
  return openConversation(PRIVATE_KEY, privateChat)
}

function groupConversation(group: string): Conversation {
  return openConversation(groupKey(group), groupChat(group))
}

function recordCommand(conv: Conversation, name: string, args: string): void {
  conv.commandLog.push({ name, args, at: Date.now() })
}

/** Attach an explanation to the command currently running. */
function noteToAgent(conv: Conversation, text: string): void {
  const last = conv.commandLog[conv.commandLog.length - 1]
  if (last) last.note = last.note ? `${last.note}\n${text}` : text
  else conv.commandLog.push({ name: 'unknown', args: '', at: Date.now(), note: text })
  log(`[${conv.key}] command note: ${text}`)
}

const xmlAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

/**
 * Prepend the command log, and whatever else the agent missed, to the
 * operator's message.
 *
 * It rides along with a real message rather than arriving as its own turn: a
 * turn of its own would have the agent respond to the event instead of to the
 * person.
 *
 * Relayed notes went out in the operator's private chat, so only the private
 * conversation drains them; another conversation taking them would leave the
 * one the operator is reading them in with no record.
 */
function withCommandLog(conv: Conversation, text: string): string {
  const relayed = conv.key === PRIVATE_KEY ? drainRelayed() : []
  const context = drainContextChange(conv)
  const restarted = drainRestartNotice(conv)
  const commandLog = conv.commandLog
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
        : restarted.signal === '/restart'
          ? `操作者在 ${hhmm(restarted.stoppedAt!)} 用 /restart 重启了 bridge，通常是为了加载新代码`
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

// -------------------------------------------------------------- group history

const history = new History(join(STATE_DIR, 'history.db'))

const HISTORY_PRUNE_EVERY_MS = 60 * 60 * 1000

function pruneHistory(): void {
  try {
    const gone = history.prune()
    if (gone) log(`history: pruned ${gone} message(s) past retention`)
  } catch (err) {
    log('history prune failed:', err)
  }
}

/** Ops by their remark, then whatever name history last saw. */
function memberName(openid: string): string | null {
  return loadAccess().ops[openid] ?? history.nameOf(openid)
}

function memberRole(openid: string): 'owner' | 'op' | null {
  const access = loadAccess()
  return isOwner(openid, access) ? 'owner' : isOp(openid, access) ? 'op' : null
}

/** Attachments as text, so an image-only message is not a blank line in history. */
function withAttachmentNotes(content: string, attachments: Attachment[]): string {
  const notes = attachments.map(a => {
    const kind = a.content_type?.startsWith('image') ? '图片' : '附件'
    return `[${kind}${a.filename ? ` ${a.filename}` : ''}]`
  })
  return [content, ...notes].filter(Boolean).join(' ')
}

// ------------------------------------------------------------------ approvals

/**
 * Process-wide: every card goes to the operator's private chat, whichever
 * conversation's agent is blocked on it. `conversation` names that one.
 */
type Pending<T> = {
  resolve: (v: T) => void
  timer: ReturnType<typeof setTimeout>
  conversation: string
}

const pendingApprovals = new Map<string, Pending<boolean>>()

type FetchedImage = { data: string; mediaType: string }

/** What answered a question: a choice or typed words, and any images sent with them. */
type QuestionAnswer = { text: string; images: FetchedImage[] }

/**
 * `render` is kept alongside the options because a page turn re-posts the same
 * question: the layout mode can change with the page, so the body has to be
 * rebuilt rather than remembered as a finished string.
 */
const pendingQuestions = new Map<
  string,
  Pending<QuestionAnswer> & {
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

function settleQuestion(id: string, text: string, images: FetchedImage[] = []): boolean {
  const p = pendingQuestions.get(id)
  if (!p) return false
  clearTimeout(p.timer)
  pendingQuestions.delete(id)
  p.resolve({ text, images })
  log(`question ${id} -> ${text.slice(0, 60)}${images.length ? ` (+${images.length} 图)` : ''}`)
  return true
}

/**
 * Cards go to the owner's private chat whichever conversation raised them, so
 * one raised from a group says which.
 */
function originNote(conv: Conversation): string | null {
  const group = groupOf(conv)
  return group ? `（来自群 \`${group}\` 的会话）` : null
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
async function askApproval(
  conv: Conversation,
  toolName: string,
  input: Record<string, unknown>,
): Promise<boolean> {
  const user = requireUser()
  const id = randomId()

  // The preview goes in a fenced block: rendered as markdown so the keyboard
  // shows, its braces and asterisks would otherwise read as formatting and
  // could disguise what is actually being approved.
  const body = [
    `**🔐 Claude 要用 ${sanitize(toolName, 40)}**`,
    ...[originNote(conv)].filter(x => x !== null),
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
    pendingApprovals.set(id, { resolve, timer, conversation: conv.key })
  })
}

// ---------------------------------------------------------------- qq_ask tool

function qqToolsFor(conv: Conversation) {
  return createSdkMcpServer({
    name: 'qq',
    version: '0.1.0',
    tools: [
      tool(
        'qq_ask',
        'Ask the operator a multiple-choice question and wait for their answer. Renders the ' +
          'options as tappable buttons on their phone and blocks until they respond, so use it ' +
          'whenever you would otherwise stop and ask — a fork in the approach, a missing detail, ' +
          'a confirmation before something hard to undo. They may also reply with free text ' +
          'instead of picking an option, in which case you get their words verbatim, along with ' +
          'any images they send. ' +
          'Keep options short: 20 characters or less renders the text on the button itself.',
        {
          question: z.string().describe('The question, stated plainly'),
          details: z
            .string()
            .optional()
            .describe(
              'Markdown shown under the question: whatever the operator needs in order to answer — ' +
                'what you found, the trade-offs, what each option leads to. Put that context here ' +
                'rather than in prose before the call; the card is the one thing sure to reach them.',
            ),
          options: z.array(z.string()).min(2).max(8).describe('Between 2 and 8 choices'),
        },
        async ({ question, details, options }) => {
          const user = requireUser()
          const id = randomId()

          const render = (mode: AskLayout['mode']) => {
            const lines = [`**${question}**`, ...[originNote(conv)].filter(x => x !== null), '']
            if (details?.trim()) lines.push(details.trim(), '')
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

          log(`question ${id} posting: ${question.slice(0, 60)}`)
          await postQuestion(user, id, options, render)
          log(`question ${id} posted`)

          const answer = await new Promise<QuestionAnswer>(resolve => {
            const timer = setTimeout(() => {
              pendingQuestions.delete(id)
              resolve({ text: '(操作者未在 15 分钟内回答)', images: [] })
            }, QUESTION_TIMEOUT_MS)
            pendingQuestions.set(id, { resolve, timer, options, render, conversation: conv.key })
          })

          return {
            content: [
              ...answer.images.map(img => ({ type: 'image' as const, data: img.data, mimeType: img.mediaType })),
              { type: 'text' as const, text: answer.text },
            ],
          }
        },
      ),
      tool(
        'qq_group_history',
        'Read the stored history of a QQ group: every message this bot received there, from people ' +
          'and other bots alike, and every message it sent. Lines are oldest first, each led by its ' +
          'message id. Defaults to the group this conversation belongs to. Page backwards with ' +
          'before_message_id; filter with query, a plain substring of the text or the sender name. ' +
          'Kept for 30 days.',
        {
          group: z.string().optional().describe("group_openid; defaults to this conversation's group"),
          limit: z.number().int().min(1).max(100).optional().describe('How many messages; default 20'),
          before_message_id: z.string().optional().describe('Only messages before this one'),
          query: z.string().optional().describe('Substring of the text or the sender name'),
        },
        async ({ group, limit, before_message_id, query }) => {
          const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
          const target = group ?? groupOf(conv)
          if (!target) {
            const known = history.groups()
            return text(
              'This conversation is not a group; pass `group`. Groups on record:\n' +
                (known.length
                  ? known.map(g => `${g.group_openid} (${g.messages} messages)`).join('\n')
                  : '(none)'),
            )
          }
          const rows = history.query({ group: target, limit, beforeMessageId: before_message_id, query })
          if (!rows.length) {
            return text(
              before_message_id && !history.get(target, before_message_id)
                ? `No message ${before_message_id} on record in this group.`
                : 'No messages match.',
            )
          }
          const now = Date.now()
          return text(
            rows
              .map(m => describeMessage(m, { ref: now, withId: true, roleOf: memberRole, nameOf: memberName }))
              .join('\n'),
          )
        },
      ),
      tool(
        'qq_op_remove',
        "Take someone off the op list, so their @ no longer starts a turn with you in any group. " +
          "For an op who keeps asking for things that would harm the owner's property or " +
          'reputation. The owner cannot be removed. The owner is told in private chat.',
        {
          member_openid: z.string().describe('The member_openid to remove'),
          reason: z.string().optional().describe('Why, in a sentence; passed on to the owner'),
        },
        async ({ member_openid, reason }) => {
          const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
          const name = loadAccess().ops[member_openid]
          const result = removeOp(member_openid)
          if (result === 'owner') return text('Refused: that is the owner, who is always an op.')
          if (result === 'absent') return text('Not on the op list; nothing changed.')
          log(`[${conv.key}] agent removed op ${member_openid}${reason ? `: ${reason}` : ''}`)
          const owner = operatorOpenid()
          if (owner) {
            await sendToQQ(
              owner,
              `🚫 agent 把 ${name ?? ''} \`${member_openid}\` 移出了 op 列表` +
                `${originNote(conv) ?? ''}${reason ? `\n理由：${reason}` : ''}`,
              lastInboundMsgId.get(owner),
            ).catch(err => log('op removal notice failed:', err))
          }
          return text(`Removed ${name ?? member_openid} from the op list.`)
        },
      ),
    ],
  })
}

// -------------------------------------------------------------- inbound routing

const APPROVAL_REPLY_RE = /^\s*(y|yes|n|no)\s*$/i
const APPROVE_BUTTON_RE = /^approve:([a-km-z]{5}):(allow|deny)$/
const ASK_BUTTON_RE = /^ask:([a-km-z]{5}):(\d+)$/
const PAGE_BUTTON_RE = /^ask:([a-km-z]{5}):p(\d+)$/

async function handleMessage(msg: InboundMessage): Promise<void> {
  const access = loadAccess()
  dropExpiredPending(access)

  if (!(access.policy === 'open' || access.allowed.includes(msg.openid))) {
    // Once there is an owner, a stranger gets no answer and leaves nothing
    // behind: a bot that replies to anyone is a bot anyone can make buzz the
    // owner's machine, and a pending code is a record kept for a stranger.
    if (access.allowed.length) {
      log('ignoring a private message from a non-allowlisted sender')
      return
    }
    // First install: never auto-promote. Hand out a code that only takes
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
  rememberInbound(msg.openid, msg.id)
  const conv = privateConversation()

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
  conv.sealPending = conv.streamOpen()

  // Commands outrank a pending prompt: an open question swallows arbitrary text
  // as its answer, so /stop would never reach anything if it were checked after.
  const deps = commandDeps(conv, { sender: msg.openid, mentions: [] })
  if (await dispatch(msg.content, deps)) return
  if (await confirmRestart(msg.content, deps)) return

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
    const { images, notes } = await readAttachments(msg.attachments)
    answer = [answer, ...notes].filter(Boolean).join('\n')
    settleQuestion(id, answer || (images.length ? '(图片)' : '(空消息)'), images)
    return
  }

  const { images, notes } = await readAttachments(msg.attachments)
  const said = [msg.content, ...notes].filter(Boolean).join('\n') || (images.length ? '(图片)' : '')
  const wrapped = wrapTurn({
    source: { kind: 'private' },
    speaker: { openid: msg.openid, name: msg.name, isOwner: isOwner(msg.openid, access), isBot: false },
    at: Date.now(),
    text: said,
  })
  log(`inbound from ${msg.openid.slice(0, 8)}: ${msg.content.slice(0, 60)}${images.length ? ` (+${images.length} 图)` : ''}`)
  enqueue(conv, withCommandLog(conv, wrapped), images)
}

/** Image first, then the words about it — the order the person sent them in. */
function enqueue(conv: Conversation, text: string, images: FetchedImage[]): void {
  if (!images.length) {
    conv.queue.push(text)
    return
  }
  const blocks: ContentBlock[] = images.map(image => ({
    type: 'image',
    source: { type: 'base64', media_type: image.mediaType, data: image.data },
  }))
  conv.queue.push([...blocks, { type: 'text', text }])
}

/**
 * Every group message is recorded; only an op's @ of this bot starts a turn.
 *
 * Recording comes first and doubles as the duplicate check — QQ documents that
 * one msg_id may be pushed more than once, and a trigger acted on twice is two
 * replies. Every message, whoever sent it, is also a passive-reply candidate.
 *
 * In a group only the owner's slash commands run; an op's slash text reaches
 * the agent like anything else they say.
 */
async function handleGroupMessage(msg: InboundGroupMessage): Promise<void> {
  const fresh = history.record({
    group_openid: msg.group,
    message_id: msg.id,
    author_openid: msg.author.openid,
    author_name: msg.author.name,
    is_bot: msg.author.bot,
    is_self: false,
    content: withAttachmentNotes(msg.content, msg.attachments),
    mentions: msg.mentions.map(m => ({ openid: m.openid, name: m.name, ...(m.isYou ? { is_you: true } : {}) })),
    ref_idx: msg.msgIdx,
    created_at: msg.at,
  })
  const where = `group ${msg.group.slice(0, 8)}`
  if (!fresh) {
    log(`${where}: duplicate push of ${msg.id.slice(-8)} ignored`)
    return
  }
  rememberGroupInbound(msg.group, msg.id)

  const access = loadAccess()
  if (routeGroupMessage(msg, id => isOp(id, access)) !== 'trigger') {
    if (mentionsMe(msg)) log(`${where}: @ from non-op ${msg.author.openid.slice(0, 8)}, recorded only`)
    return
  }

  const conv = groupConversation(msg.group)
  // See handleMessage: the seal waits for the message to reach the model.
  conv.sealPending = conv.streamOpen()

  const owner = isOwner(msg.author.openid, access)
  if (owner) {
    const text = commandText(msg)
    const deps = commandDeps(conv, { sender: msg.author.openid, mentions: msg.mentions })
    if (await dispatch(text, deps)) return
    if (await confirmRestart(text, deps)) return
  }

  const { images, notes } = await readAttachments(msg.attachments)
  const said = [msg.content, ...notes].filter(Boolean).join('\n') || (images.length ? '(图片)' : '')
  conv.lastTrigger = `${msg.author.name}：${renderMentions(said, msg.mentions, memberName)}`.slice(0, 200)
  const wrapped = wrapTurn({
    source: { kind: 'group', group: msg.group },
    speaker: { openid: msg.author.openid, name: msg.author.name, isOwner: owner, isBot: msg.author.bot },
    at: msg.at,
    recent: history.query({ group: msg.group, beforeMessageId: msg.id, limit: RECENT_IN_CONTEXT }),
    roleOf: memberRole,
    nameOf: memberName,
    text: said,
    mentions: msg.mentions,
  })
  log(`${where}: trigger from ${msg.author.openid.slice(0, 8)}: ${msg.content.slice(0, 60)}`)
  enqueue(conv, withCommandLog(conv, wrapped), images)
  ensureServing(conv)
}

/**
 * Images are fetched and inlined: a CDN link is something Claude cannot see,
 * and QQ's links expire. Anything that is not an image still goes as a URL,
 * which is all a non-image attachment can usefully be.
 */
async function readAttachments(attachments: Attachment[]): Promise<{ images: FetchedImage[]; notes: string[] }> {
  const images: FetchedImage[] = []
  const notes: string[] = []
  for (const att of attachments) {
    if (!att.url) continue
    const isImage = att.content_type?.includes('image') || /\.(jpe?g|png|gif|webp)$/i.test(att.url)
    if (!isImage) {
      notes.push(`[文件] ${att.filename ?? ''} ${att.url}`.trim())
      continue
    }
    const image = await fetchImage(att.url, att.content_type)
    if (image) images.push(image)
    else notes.push(`[图片下载失败] ${att.url}`)
  }
  return { images, notes }
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
 * What survives a restart, per conversation.
 *
 * The session id matters most — without it every restart starts a fresh
 * conversation — but workdir and permission mode are just as load-bearing:
 * a bridge that forgets them silently runs the next task in the wrong
 * directory, or under stricter rules than the operator last chose.
 */
type ConversationState = {
  session_id?: string | null
  workdir?: string
  permission_mode?: string
  trace_level?: TraceLevel
}

/**
 * The whole file. The private conversation's fields sit at the top level and
 * every other conversation's live under `conversations`, by key.
 *
 * Do not move the private one into the map. The crash rollback in service/ can
 * check out a commit that only knows the top-level shape, and that commit would
 * find no session id and start the operator over with no context — the one
 * failure this file exists to prevent.
 */
type BridgeState = ConversationState & {
  conversations?: Record<string, ConversationState>
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

function loadConversationState(key: string): ConversationState {
  const state = loadState()
  if (key !== PRIVATE_KEY) return state.conversations?.[key] ?? {}
  const { session_id, workdir, permission_mode, trace_level } = state
  return { session_id, workdir, permission_mode, trace_level }
}

function patchConversationState(key: string, patch: ConversationState): void {
  if (key === PRIVATE_KEY) return patchState(patch)
  const all = loadState().conversations ?? {}
  patchState({ conversations: { ...all, [key]: { ...all[key], ...patch } } })
}

// ------------------------------------------------------------------- commands

/**
 * Present options as buttons and wait for a choice.
 *
 * Shares the question machinery with qq_ask: a selection is the same
 * interaction, and reusing it keeps one code path for buttons, letter replies,
 * and free text.
 */
async function askChoice(
  conv: Conversation,
  options: string[],
  renderBody: (mode: AskLayout['mode']) => string,
  buttonsOnly = false,
): Promise<number> {
  const user = requireUser()
  const id = randomId()

  await postQuestion(user, id, options, renderBody)

  const answer = await new Promise<QuestionAnswer>(resolve => {
    const timer = setTimeout(() => {
      pendingQuestions.delete(id)
      resolve({ text: '', images: [] })
    }, QUESTION_TIMEOUT_MS)
    pendingQuestions.set(id, { options, resolve, timer, render: renderBody, buttonsOnly, conversation: conv.key })
  })
  return options.indexOf(answer.text)
}

/** Who sent a command, and whom their message @'d. */
type CommandOrigin = { sender: string; mentions: GroupMember[] }

/**
 * Everything the command layer is allowed to touch, and nothing more. A
 * command acts on the conversation it was sent in.
 */
function commandDeps(conv: Conversation, origin: CommandOrigin): CommandDeps {
  return {
    reply: text => conv.chat.send(text),
    askChoice: (options, render) => askChoice(conv, options, render, true),
    query: () => conv.query,
    workdir: () => conv.workdir,
    setWorkdir: path => conv.setWorkdir(path),
    restartSession: reason => {
      conv.restartReason = reason
      conv.query?.close()
    },
    sessionId: () => conv.sessionId(),
    setSessionId: id => conv.setSessionId(id),
    noteToAgent: text => noteToAgent(conv, text),
    recordCommand: (name, args) => recordCommand(conv, name, args),
    permissionMode: () => conv.permissionMode,
    setPermissionMode: mode => conv.setPermissionMode(mode),
    verbose: () => conv.traceLevel,
    setVerbose: level => conv.setTraceLevel(level),
    counts: () => ({
      allowed: loadAccess().allowed.length,
      approvals: pendingApprovals.size,
      questions: pendingQuestions.size,
    }),
    supervisor: () => {
      const s = process.env.CLAUDE_IN_QQ_SUPERVISOR
      return s === 'launchd' || s === 'schtasks' ? s : null
    },
    restartProcess: remark => {
      if (remark) appendFileSync(WAKE_FILE, `\n\n## 操作者附言（随 /restart 发送）\n\n${remark}\n`)
      void shutdown('/restart')
    },
    senderIsOwner: () => isOwner(origin.sender),
    nameOf: openid => origin.mentions.find(m => m.openid === openid)?.name || memberName(openid),
    listOps: () => Object.entries(loadAccess().ops).map(([openid, remark]) => ({ openid, remark })),
    addOp,
    removeOp,
  }
}

// ------------------------------------------------------------------ main loop

/** Above this, prose is its own message so it keeps markdown rendering. */
const CAPTION_LIMIT = 200

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
function shortPath(value: unknown, workdir: string): string {
  const path = String(value ?? '')
  const rel = workdir && path.startsWith(workdir) ? path.slice(workdir.length + 1) : path
  return oneLine(rel || path)
}

/** How a subagent's end reads, by the status it ended with; others are not an end. */
const SUBAGENT_OUTCOMES: Record<string, string> = {
  completed: '✅ 子代理完成',
  failed: '❌ 子代理失败',
  stopped: '⏹ 子代理已停止',
  killed: '⏹ 子代理已停止',
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

/** Spawning a subagent is announced by its own start line instead. */
function isSubagentTool(name: string): boolean {
  return name === 'Agent' || name === 'Task'
}

/**
 * The trace line for a tool call, or null to leave it out.
 *
 * The bridge's own tools are left out: they exist to talk to the operator, so
 * narrating "asking you a question" directly above the question is telling
 * someone what you are about to tell them.
 */
function summariseTool(name: string, input: Record<string, any>, workdir: string): string | null {
  if (name.startsWith('mcp__qq__') || isSubagentTool(name)) return null

  const arg = (() => {
    switch (name) {
      case 'Bash':
        return oneLine(input.command)
      case 'Read':
      case 'Write':
        return shortPath(input.file_path, workdir)
      case 'Edit': {
        const delta = String(input.new_string ?? '').length - String(input.old_string ?? '').length
        return `${shortPath(input.file_path, workdir)} ${delta >= 0 ? '+' : '−'}${Math.abs(delta)}`
      }
      case 'Grep':
        return oneLine(input.pattern)
      case 'Glob':
        return oneLine(input.pattern)
      case 'WebFetch':
        return oneLine(input.url)
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
async function deliverReply(conv: Conversation, text: string): Promise<void> {
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
  if (remaining && !asCaption) await conv.chat.send(remaining)

  for (const [i, path] of paths.entries()) {
    try {
      await conv.chat.sendFile(nativePath(path, conv.workdir), asCaption && i === 0 ? remaining : undefined)
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
  private static nextId = 1
  /** Names this streamer in the log, so a seal can be matched to what it sealed. */
  readonly id = LineStreamer.nextId++
  /** Set once finish() starts; text pushed after that has no close coming. */
  private finished = false
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
    if (this.finished) log(`streamer #${this.id} push after finish (${channel}): ${JSON.stringify(delta.slice(0, 80))}`)
    if (channel !== this.channel) await this.switchTo(channel)
    if (this.channel === 'prose') this.trackFenceLines(delta)
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

  /** The line being assembled for fence tracking, however the text was cut up. */
  private fenceLine = ''

  /**
   * Feed the reply's text through, line by logical line.
   *
   * Deliberately driven from `push` rather than from `emit`. A line is released
   * as soon as it can no longer be a MEDIA line, long before its newline
   * arrives, and that release sets `atLineStart` false — which is the very test
   * `emit` gated fence tracking on. So a fence the model happened to split, as
   * "``" then "`ts\n", was never recorded: `proseFence` stayed null, the trace
   * block opened inside a code block the streamer did not know was open, and
   * every fence after it landed on the wrong side. Whether a reply came out
   * right came down to where the model put its delta boundaries.
   *
   * Do not move this back into `emit`, and do not call it from both — a whole
   * line arriving in one delta would then toggle the fence twice.
   */
  private trackFenceLines(text: string): void {
    this.fenceLine += text
    for (let nl = this.fenceLine.indexOf('\n'); nl >= 0; nl = this.fenceLine.indexOf('\n')) {
      this.trackProseFence(this.fenceLine.slice(0, nl))
      this.fenceLine = this.fenceLine.slice(nl + 1)
    }
  }

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
    this.finished = true
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
      log(`streamer #${this.id} posting ${rest.length} chars of overflow as a message`)
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
    if (!this.stream && this.finished) log(`streamer #${this.id} opening a stream after finish — nothing will close it`)
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
      if (!this.overflow) log(`streamer #${this.id} diverting to overflow (stream failed, exhausted=${this.stream.exhausted})`)
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
      // Fence tracking does not happen here — see trackFenceLines for why this
      // is the wrong place for it.
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

/**
 * Run one agent session for `conv` until it ends. Returns when the query
 * closes.
 */
async function runSession(conv: Conversation): Promise<void> {
  // The previous session's iterator may still be parked on this queue.
  conv.queue.detachWaiters()

  const resume = conv.sessionId()
  log(`[${conv.key}] ${resume ? `resuming session ${resume}` : 'starting a new session'}`)

  const q = query({
    prompt: conv.queue,
    options: {
      systemPrompt: { type: 'preset', preset: 'claude_code', append: OPERATOR_CONTEXT },
      cwd: conv.workdir,
      // 'auto' lets a classifier clear the routine calls and only escalate what
      // it considers risky. 'default' escalates every write and every command,
      // which on a phone means approving your way through the whole task.
      permissionMode: conv.permissionMode,
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
      // Claude in Chrome: drives the operator's own browser, logins included.
      // Needs the extension and a /login session; without them the tools only
      // report the extension as not connected and everything else carries on.
      extraArgs: { chrome: null },
      canUseTool: async (toolName: string, input: Record<string, unknown>) => {
        // This bridge's own tools only talk to the operator — they touch no
        // files, run no commands, and reach nothing outside the chat. Gating
        // them means asking permission to ask a question, which costs two
        // round trips on a phone to answer one prompt.
        if (toolName.startsWith('mcp__qq__')) {
          return { behavior: 'allow' as const, updatedInput: input }
        }
        const allow = await askApproval(conv, toolName, input)
        return allow
          ? { behavior: 'allow' as const, updatedInput: input }
          : { behavior: 'deny' as const, message: '操作者在 QQ 上拒绝了这次调用' }
      },
      mcpServers: { qq: conv.tools },
    } as any,
  })
  conv.query = q

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

  /**
   * Whether the streamer is sending an attachment from one of its own MEDIA
   * lines. It ends its own message before the file goes out, so the seal that
   * `sendFile` runs on the way finds nothing above it to close.
   */
  let sendingOwnMedia = false

  async function closeStreamer(reason = 'before send'): Promise<boolean> {
    if (streamer) log(`sealing streamer #${streamer.id}: ${reason}${sendingOwnMedia ? ' (skipped: own media)' : ''}`)
    // Not a seal at all: the streamer is mid-emit, and finishing it from inside
    // would flush the partial line it holds back — the "M" of the next MEDIA
    // line goes out as text, and the rest of that line, landing in a fresh
    // streamer that never saw its start, is no longer recognised as one.
    if (sendingOwnMedia) return false
    // Settled either way: with no stream open there is nothing left for a
    // pending seal to wait for, and leaving it armed would cut the *next*
    // reply at its first tool result for no reason.
    conv.sealPending = false
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

  conv.sealStream = closeStreamer
  conv.streamOpen = () => streamer !== null


  /** Which content block the deltas currently belong to. */
  let block: string | null = null
  /** Text received through deltas in the current block, for the event log. */
  let blockTextChars = 0
  /** tool_use id → name, so a result can be matched to the call that made it. */
  const toolNames = new Map<string, string>()
  /**
   * Subagents still working, by task id. Their own frames are never shown, so
   * a start and an end line are all the operator gets — enough to tell a long
   * wait from a hang. Outlives turns: a background one ends in a later one.
   */
  const subagents = new Map<string, { description: string; startedAt: number }>()

  async function traceSubagent(line: string): Promise<void> {
    await traceBreak()
    await trace(`${line}\n`)
    traceStarted = true
    lastKind = null
  }

  function newStreamer(): LineStreamer {
    const s = new LineStreamer(
      () => conv.chat.openStream(),
      async path => {
        sendingOwnMedia = true
        try {
          await conv.chat.sendFile(nativePath(path, conv.workdir))
          log(`sent file ${path}`)
        } catch (err) {
          log(`failed to send ${path}:`, err)
        } finally {
          sendingOwnMedia = false
        }
      },
      async text => {
        await conv.chat.send(text)
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

    // A subagent's frames carry the Agent call that spawned it. They are its
    // own work, not the operator's conversation: tracing them floods the chat
    // with another agent's Bash and Edit, and their tool results would also
    // drain `toolNames` and fire the mid-turn seal at the wrong boundary. The
    // Agent call itself is a top-level frame and is still traced.
    if (m.parent_tool_use_id) continue

    if (m.type === 'system' && m.subtype === 'init') {
      // Persist immediately: a crash before the first reply should still leave
      // a resumable session behind.
      if (m.session_id) conv.setSessionId(m.session_id)
    } else if (m.type === 'system' && m.subtype === 'task_started') {
      if (m.task_type === 'local_agent' && !m.ambient) {
        subagents.set(m.task_id, { description: m.description, startedAt: Date.now() })
        await traceSubagent(`🤖 已创建子代理：${m.description}（当前 ${subagents.size} 个）`)
      }
    } else if (m.type === 'system' && (m.subtype === 'task_notification' || m.subtype === 'task_updated')) {
      // A task can report its end both ways; whichever lands first removes it,
      // so the other finds nothing and says nothing.
      const status: string | undefined = m.subtype === 'task_notification' ? m.status : m.patch?.status
      const agent = subagents.get(m.task_id)
      const outcome = status ? SUBAGENT_OUTCOMES[status] : undefined
      if (agent && outcome) {
        subagents.delete(m.task_id)
        const took = formatDuration(m.usage?.duration_ms ?? Date.now() - agent.startedAt)
        await traceSubagent(`${outcome}：${agent.description}，用时 ${took}（剩 ${subagents.size} 个）`)
      }
    } else if (m.type === 'stream_event') {
      // Everything the operator sees is driven from here rather than from the
      // finished assistant message, because only the event order says what
      // happened when: a thought, then the call it led to, then the next
      // thought. Reading tool calls off the finished message instead would
      // stack them after their own reasoning.
      const ev = m.event
      if (ev?.type === 'content_block_delta') {
        if (ev.delta?.type === 'text_delta') blockTextChars += ev.delta.text.length
      } else if (ev?.type === 'content_block_stop') {
        log(`event: block stop #${ev.index} (${block})${block === 'text' ? ` ${blockTextChars} chars` : ''}`)
      } else {
        log(`event: ${ev?.type}${ev?.type === 'content_block_start' ? ` #${ev.index} ${ev.content_block?.type}${ev.content_block?.name ? ` ${ev.content_block.name}` : ''}` : ''}`)
      }
      if (ev?.type === 'content_block_start') {
        blockTextChars = 0
        block = ev.content_block?.type ?? null
        if (block === 'thinking' && conv.traceLevel === 'full') {
          await traceBreak()
          await trace('💭 ')
          traceStarted = true
          lastKind = 'thinking'
        } else if (block === 'thinking' && conv.traceLevel === 'balanced') {
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
          if (!streamer) {
            streamer = newStreamer()
            log(`[${conv.key}] streamer #${streamer.id} created for ${conv.chat.replyTo()?.slice(-8) ?? 'none'}`)
          }
          streamedText = true
          // Prose closes the block; a later one starts its own entry list.
          traceStarted = false
          lastKind = null
          try {
            await streamer.push(delta.text)
          } catch (err) {
            log('stream push failed:', err)
          }
        } else if (delta?.type === 'thinking_delta' && conv.traceLevel === 'full') {
          await trace(delta.thinking)
        }
      } else if (ev?.type === 'content_block_stop') {
        // A thinking summary may or may not end its own last line, and the
        // trace only flushes whole lines — without this the last thought can
        // sit in the buffer until something else happens to end one.
        if (block === 'thinking' && conv.traceLevel === 'full') await traceEndLine()
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
      log(
        `assistant msg: ${(m.message?.content ?? [])
          .map((b: { type: string; text?: string; name?: string }) =>
            b.type === 'text' ? `text(${b.text?.length})` : b.type === 'tool_use' ? `tool_use(${b.name})` : b.type,
          )
          .join(', ')} streamedText=${streamedText}`,
      )
      for (const b of m.message?.content ?? []) {
        if (b.type === 'text' && b.text.trim() && !streamedText) {
          try {
            await deliverReply(conv, b.text.trim())
          } catch (err) {
            log('failed to deliver reply:', err)
          }
        } else if (b.type === 'tool_use') {
          toolNames.set(b.id, b.name)
          if (conv.traceLevel === 'full') {
            const line = summariseTool(b.name, b.input ?? {}, conv.workdir)
            if (line) {
              await traceBreak()
              await trace(`${line}\n`)
              traceStarted = true
              lastKind = 'tools'
            }
          } else if (conv.traceLevel === 'balanced' && !b.name.startsWith('mcp__qq__') && !isSubagentTool(b.name)) {
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
        if (!name || conv.traceLevel !== 'full') continue
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
      if (sawToolResult && conv.sealPending && toolNames.size === 0) await closeStreamer('operator message joins')
    } else if (m.type === 'result') {
      // Where the stream closes when nothing closed it earlier. A turn can also
      // end without a final assistant message (interrupt, error), and this
      // catches that too rather than leaving it half-written. The trace
      // bookkeeping is reset by closeStreamer itself.
      await closeStreamer('turn end')
      block = null
      streamedText = false
      // A fence is only carried across a seal inside one reply. A turn that
      // ended inside one left it unbalanced on its own, and reopening it over
      // the next turn's first words would spread one mistake across two.
      carriedFence = null
      toolNames.clear()
      log(`[${conv.key}] turn finished: ${m.subtype}, turns=${m.num_turns}`)
    }
  }
}

// ---------------------------------------------------------------- wake note
//
// A restart ends the agent's turn, and nothing makes it take the next one until
// the operator writes in. So before restarting itself the agent can leave a
// note; the next process hands it straight back as a message, which lets work
// that needed a restart carry on without a prod from the phone.

const WAKE_FILE = join(STATE_DIR, 'wake.md')
/** How much of the note the operator sees in the wake notice. */
const WAKE_PREVIEW = 300

/** Hand the note to `conv` — the private conversation, which the operator reads. */
function deliverWakeNote(conv: Conversation): void {
  if (!existsSync(WAKE_FILE)) return
  const note = readFileSync(WAKE_FILE, 'utf8').trim()
  if (!note) return
  const writtenAt = statSync(WAKE_FILE).mtimeMs
  // Emptied before anything else can fail: a note still in place when this
  // process dies would wake the next one too, and a note whose work crashes the
  // bridge would restart it forever. The copy in `.last` is for reading back
  // what was delivered; nothing ever reads it to wake from.
  writeFileSync(WAKE_FILE, '')
  writeFileSync(`${WAKE_FILE}.last`, `${note}\n`)

  log(`wake note found (${note.length} chars), delivering`)
  const user = requireUser()
  const preview = note.length > WAKE_PREVIEW ? `${note.slice(0, WAKE_PREVIEW)}…` : note
  void sendToQQ(user, `⏰ 重启后按唤醒便条自动接续：\n\n${preview}`).catch(err =>
    log('wake notice failed:', err),
  )
  conv.queue.push(
    withCommandLog(
      conv,
      `<system-reminder>\n这是 \`${WAKE_FILE}\` 里的唤醒便条（最后写入于 ${spokenGap(Date.now() - writtenAt)}前），` +
        'bridge 重启后自动投递；操作者已收到「自动唤醒」的通知和便条开头。' +
        '没有标题的部分是你重启前写给自己的交接；「操作者附言」是操作者重启时附上的话，以附言为准。' +
        '文件已清空、原文另存为 `wake.md.last`，不会再触发。按便条继续，做完照常汇报；若情况和便条描述的对不上，先说清楚再动手。' +
        '\n</system-reminder>\n\n' +
        note,
    ),
  )
}

// ------------------------------------------------------------ crash rollback
//
// The launch scripts in service/ count launches in `crash-count` and, after
// three that never got here, check out `last-good-commit`. Both files are only
// meaningful to that pair, so the format stays a bare number and a bare hash.

const CRASH_COUNT_FILE = join(STATE_DIR, 'crash-count')
const LAST_GOOD_FILE = join(STATE_DIR, 'last-good-commit')
/** How long a process has to stay up before its commit counts as good. */
const HEALTHY_AFTER_MS = 60_000

function resetCrashCount(): void {
  try {
    writeFileSync(CRASH_COUNT_FILE, '0\n')
  } catch (err) {
    log('crash count reset failed:', err)
  }
}

function markHealthy(): void {
  resetCrashCount()
  const head = buildHead()
  if (!head) return
  try {
    writeFileSync(LAST_GOOD_FILE, `${head}\n`)
    log(`healthy for ${HEALTHY_AFTER_MS / 1000}s, last good commit ${head.slice(0, 7)}`)
  } catch (err) {
    log('last good commit not recorded:', err)
  }
}

/**
 * Keep `conv` served for the life of the process.
 *
 * The session is rebuilt rather than the process restarted: /clear and /cwd
 * both need a fresh query, and a crashed query should not take the QQ
 * connection, or any other conversation, down with it.
 */
async function serve(conv: Conversation): Promise<never> {
  while (true) {
    try {
      await runSession(conv)
    } catch (err) {
      log(`[${conv.key}] session ended with error:`, err)
    }
    conv.query = null
    if (conv.restartReason) {
      log(`[${conv.key}] rebuilding session after /${conv.restartReason}`)
      conv.restartReason = null
      continue
    }
    await new Promise(r => setTimeout(r, 1000))
  }
}

/** Conversations whose session loop is running. */
const serving = new Set<string>()

/**
 * Start `conv`'s session loop unless it has one. A group's starts on its first
 * trigger and then runs for the life of the process, like the private one.
 * A cap on concurrent group sessions, or closing idle ones, belongs here.
 */
function ensureServing(conv: Conversation): void {
  if (serving.has(conv.key)) return
  serving.add(conv.key)
  void serve(conv)
}

async function main(): Promise<void> {
  const state = loadState()

  // A conversation with a session on disk is picking up where it left off
  // rather than starting, which its agent has no other way to find out. Built
  // before any conversation is opened, since opening one is what arms it.
  const now = Date.now()
  const bootedAt = now - uptime() * 1000
  startupNotice = {
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
  const priv = privateConversation()
  if (priv.restartNotice) {
    log(`resuming an existing session; previous stop: ${state.stopped_by ?? 'none recorded'}`)
  }
  // Cleared whether or not it was reported, so the next restart cannot inherit
  // this one's cause and describe a shutdown that already happened.
  if (state.stopped_at || state.stopped_by) {
    patchState({ stopped_at: null, stopped_by: null, stopped_error: null })
  }

  // Sealing before a standalone message, installed once: the stream sealed is
  // the one open in the chat the message is going to. No exceptions — see
  // `beforeSend` in qq.ts.
  onBeforeSend(async openid => {
    for (const conv of conversations.values()) {
      if (conv.chat.owns(openid)) await conv.sealStream()
    }
  })

  // This bot's own group messages never come back as events; this is how
  // they reach the group's history.
  onGroupSent((group, sent) => {
    try {
      history.record({
        group_openid: group,
        message_id: sent.id || `self-${Date.now()}-${randomId()}`,
        author_openid: '',
        author_name: '',
        is_bot: true,
        is_self: true,
        content: sent.content,
        mentions: [],
        ref_idx: sent.refIdx,
        created_at: Date.now(),
      })
    } catch (err) {
      log('history: own group message not recorded:', err)
    }
  })

  pruneHistory()
  setInterval(pruneHistory, HISTORY_PRUNE_EVERY_MS).unref()

  if (!HAS_CREDENTIALS) {
    log('QQ_APP_ID / QQ_CLIENT_SECRET missing — run: bun run onboard.ts')
    process.exit(1)
  }

  await connectGateway({ onMessage: handleMessage, onGroupMessage: handleGroupMessage, onButton: handleButton })
  log(`bridge up, workdir=${priv.workdir}, mode=${priv.permissionMode}, state=${STATE_DIR}`)

  setTimeout(markHealthy, HEALTHY_AFTER_MS).unref()

  // After the restart notice is armed, so the note and the notice arrive together.
  try {
    deliverWakeNote(priv)
  } catch (err) {
    log('wake note unreadable, skipped:', err)
  }

  // Republish the command panel, so editing a command is enough to change what
  // the operator sees under "/". Safe to repeat: the sync updates the existing
  // panel rather than adding one. Deliberately not awaited and never fatal — a
  // bridge that will not start because a cosmetic list failed to update would
  // be a bad trade, and the panel QQ already has stays usable meanwhile.
  void syncCommandPanel(allCommands().map(c => ({ name: `/${c.name}`, desc: c.summary })))
    .then(id => log(`command panel synced (${id})`))
    .catch(err => log('command panel sync failed, keeping the existing one:', err))

  serving.add(priv.key)
  await serve(priv)
}

/**
 * Leave every conversation in a finished state before going.
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
  // A deliberate stop is not a crash, however soon after start it comes.
  resetCrashCount()
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref()
  // All at once: they share one grace period, and one slow chat must not use
  // it up for the rest.
  await Promise.all(
    [...conversations.values()].map(async conv => {
      try {
        // Only where a reply was actually in flight. A restart while idle needs
        // no apology, and nobody wants a notification for one.
        if (await conv.sealStream()) await conv.chat.send('⏸ claude-in-qq 正在断开连接。')
      } catch (err) {
        log(`[${conv.key}] shutdown notice failed:`, err)
      }
    }),
  )
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
