/**
 * What reaches the agent: which group messages start a turn, when bots stop
 * being answered, what a command is read from, and how every inbound message
 * — and every message one conversation leaves another — is wrapped before the
 * agent sees it.
 *
 * Pure functions over plain data, so routing and wrapping can be checked
 * against captured payloads without a gateway or a session.
 */

import type { HistoryMessage } from './history.js'
import type { InboundGroupMessage } from './qq.js'

/** Whether this message @'s this bot, by either of the two ways QQ reports it. */
export function mentionsMe(msg: InboundGroupMessage): boolean {
  return msg.atEvent || msg.mentions.some(m => m.isYou)
}

/** What may follow a nickname before the words addressed to the bot begin. */
const NICKNAME_SEPARATOR = /^[\s，,：:、]+/

/**
 * The text after the nickname `content` opens with, or null when it opens
 * with none. Only the very start counts — a nickname mid-sentence is someone
 * talking about the bot, not to it. The longest matching nickname wins, so
 * one that is a prefix of another cannot cut it short; case is ignored.
 */
export function stripNickname(content: string, nicknames: string[]): string | null {
  const hit = [...nicknames]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .find(n => content.slice(0, n.length).toLowerCase() === n.toLowerCase())
  return hit === undefined ? null : content.slice(hit.length).replace(NICKNAME_SEPARATOR, '')
}

/**
 * A group message starts a turn only when an op — the owner, a listed member,
 * or a listed bot — @'s this bot or opens with one of its nicknames.
 * Everything else is only recorded.
 */
export function routeGroupMessage(
  msg: InboundGroupMessage,
  isOp: (openid: string) => boolean,
  nicknames: string[] = [],
): 'trigger' | 'history' {
  const addressed = mentionsMe(msg) || stripNickname(msg.content, nicknames) !== null
  return addressed && isOp(msg.author.openid) ? 'trigger' : 'history'
}

/** How many bot @'s in a row a group gets answered before a human op has to speak. */
export const BOT_ROUND_LIMIT = 6

/**
 * Consecutive bot triggers per group, so two bots @'ing each other cannot keep
 * a conversation going on their own. Any human op speaking in the group, @ or
 * not, starts the count over. In memory only: a restart is a human act too.
 */
export class BotRounds {
  private readonly counts = new Map<string, number>()

  /** A human op spoke. Returns whether the group had been cut off from bots. */
  human(group: string): boolean {
    const was = this.counts.get(group) ?? 0
    this.counts.delete(group)
    return was > BOT_ROUND_LIMIT
  }

  /**
   * A bot triggered. `answer` while within the limit, `trip` on the one that
   * crosses it (the owner is told once), `muted` after that.
   */
  bot(group: string): 'answer' | 'trip' | 'muted' {
    const n = (this.counts.get(group) ?? 0) + 1
    this.counts.set(group, n)
    return n <= BOT_ROUND_LIMIT ? 'answer' : n === BOT_ROUND_LIMIT + 1 ? 'trip' : 'muted'
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The text a slash command is read from: this bot's own mentions removed,
 * wherever they sit, so `@bot /cwd x` and `/cwd x @bot` both parse, then a
 * leading nickname, so `小克 /cwd x` does too.
 */
export function commandText(msg: InboundGroupMessage, nicknames: string[] = []): string {
  let text = msg.content
  for (const m of msg.mentions) {
    if (m.isYou && m.openid) text = text.replace(new RegExp(`<@!?${escapeRe(m.openid)}>`, 'g'), ' ')
  }
  text = text.trim()
  return (stripNickname(text, nicknames) ?? text).trim()
}

/**
 * `<@member_openid>` → `@名字`, by the names the message itself carries, then
 * by `nameOf`. An id with no known name stays as written, which still tells
 * the agent who was meant.
 */
export function renderMentions(
  content: string,
  mentions: { openid: string; name: string }[],
  nameOf: (openid: string) => string | null = () => null,
): string {
  return content.replace(/<@!?([A-Za-z0-9]+)>/g, (whole, id: string) => {
    const name = mentions.find(m => m.openid === id)?.name || nameOf(id)
    return name ? `@${name}` : whole
  })
}

/**
 * Break any of the bridge's own framing tags inside untrusted text. Anyone in
 * a group can put words in the history block, and a closing `</turn_context>`
 * or a forged `<system-reminder>` there would otherwise read as the bridge
 * speaking.
 */
export function neutralize(text: string): string {
  return text.replace(
    /<(\/?)(turn_context|user_message|conversation_message|quoted_message|harness-reminder|system-reminder)/gi,
    '＜$1$2',
  )
}

export type Speaker = { openid: string; name: string; isOwner: boolean; isBot: boolean }

/** What the formatter needs to know about members beyond the message itself. */
export type MemberLookup = {
  /** A member's role, for labelling lines. */
  roleOf?: (openid: string) => 'owner' | 'op' | null
  /** Fallback names for mentions the message itself does not name. */
  nameOf?: (openid: string) => string | null
}

export type TurnInput = MemberLookup & {
  /**
   * A group is shown by `label` — its display name, or the head of its openid
   * when it has none — and by its conversation key, which is what
   * qq_message_agent and qq_group_history take.
   */
  source: { kind: 'private' } | { kind: 'group'; label: string; key: string }
  speaker: Speaker
  at: number
  /** Group only: the messages before the trigger, oldest first. */
  recent?: HistoryMessage[]
  /** The message itself, mentions still as `<@id>`. */
  text: string
  mentions?: { openid: string; name: string }[]
}

/** How many earlier group messages ride along with a trigger. */
export const RECENT_IN_CONTEXT = 10
/** How much of each earlier message; the history tool has the rest. */
const RECENT_CLIP = 200

const yesNo = (v: boolean) => (v ? '是' : '否')

function fullTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

/** Clock time, with the date in front when it is not `ref`'s day. */
function stamp(ms: number, ref: number): string {
  const d = new Date(ms)
  const time = d.toLocaleTimeString('zh-CN', { hour12: false })
  return d.toDateString() === new Date(ref).toDateString()
    ? time
    : `${d.getMonth() + 1}/${d.getDate()} ${time}`
}

/**
 * One stored group message as one line: time, sender with role tags, text
 * with mentions as names. `clip` shortens the text and folds its line breaks;
 * `withId` leads with the message id, for paging and referring back.
 */
export function describeMessage(
  m: HistoryMessage,
  opts: MemberLookup & { ref: number; clip?: number; withId?: boolean },
): string {
  let body = renderMentions(m.content, m.mentions, opts.nameOf)
  if (opts.clip) {
    body = body.replace(/\s*\n\s*/g, ' ⏎ ')
    if (body.length > opts.clip) body = `${body.slice(0, opts.clip)}…`
  }
  const head = `${opts.withId ? `${m.message_id} ` : ''}[${stamp(m.created_at, opts.ref)}]`
  if (m.is_self) return `${head} 你（本 bot）：${neutralize(body)}`
  const role = opts.roleOf?.(m.author_openid)
  const tags = [role === 'owner' ? '主人' : role === 'op' ? 'op' : '', m.is_bot ? 'bot' : '']
    .filter(Boolean)
    .map(t => `[${t}]`)
    .join('')
  return `${head} ${neutralize(m.author_name)} (${m.author_openid})${tags ? ` ${tags}` : ''}：${neutralize(body)}`
}

/**
 * Wrap an inbound message for the agent: who said it, where and when, what
 * the group said just before, then the message itself.
 */
export function wrapTurn(input: TurnInput): string {
  const { speaker } = input
  const lines = ['<turn_context>']
  lines.push(
    input.source.kind === 'group'
      ? `来源：群 ${neutralize(input.source.label)}（会话 ${input.source.key}）`
      : '来源：私聊',
  )
  const name = speaker.name ? `${neutralize(speaker.name)} ` : ''
  lines.push(
    `发言人：${name}(${speaker.openid})，主人：${yesNo(speaker.isOwner)}，bot：${yesNo(speaker.isBot)}`,
  )
  lines.push(`时间：${fullTime(input.at)}`)
  if (input.source.kind === 'group') {
    const recent = input.recent ?? []
    if (recent.length) {
      lines.push(`最近群消息（触发消息之前 ${recent.length} 条，旧→新）：`)
      for (const m of recent) lines.push(describeMessage(m, { ...input, ref: input.at, clip: RECENT_CLIP }))
    } else {
      lines.push('最近群消息：（无记录）')
    }
  }
  lines.push('</turn_context>')
  const body = renderMentions(input.text, input.mentions ?? [], input.nameOf)
  lines.push('<user_message>', neutralize(body), '</user_message>')
  return lines.join('\n')
}

/** How long an originating message is quoted in a delivery's context. */
const ORIGIN_CLIP = 200

/**
 * The QQ message a chain of deliveries started from, as one line: who, where,
 * and what they said with line breaks folded. `text` has mentions rendered.
 */
export function describeOrigin(speaker: Speaker, where: string, text: string): string {
  let said = text.replace(/\s*\n\s*/g, ' ⏎ ')
  if (said.length > ORIGIN_CLIP) said = `${said.slice(0, ORIGIN_CLIP)}…`
  const tags = [speaker.isOwner ? '主人' : '', speaker.isBot ? 'bot' : ''].filter(Boolean).map(t => `[${t}]`).join('')
  const name = speaker.name ? `${speaker.name} ` : ''
  return `${name}(${speaker.openid})${tags ? ` ${tags}` : ''} 在${where}说：${said}`
}

export type DeliveryInput = {
  /** The sending conversation: its key, and how it is shown ('私聊', '群 名字'). */
  from: { key: string; label: string }
  /** From `describeOrigin`; null when no QQ message started the chain. */
  origin: string | null
  /** 1 for a delivery made while answering a QQ message, one more per hop after. */
  depth: number
  limit: number
  at: number
  text: string
}

/**
 * Wrap a message one conversation's agent sent another's with
 * qq_message_agent. It is not anyone's words in this chat, so it travels in
 * its own tag rather than as a `<user_message>`. The context says which
 * conversation sent it, which QQ message set the chain off, and that the turn
 * is silent (see `Conversation.silent` in index.ts). Everything in it is
 * neutralized: the sender is an agent, but what it passes on may be quoted
 * from anyone.
 */
export function wrapDelivery(d: DeliveryInput): string {
  return [
    '<turn_context>',
    `来源：会话留言，来自${neutralize(d.from.label)}（会话 ${d.from.key}）`,
    d.origin ? `起因：${neutralize(d.origin)}` : '起因：（不是由 QQ 消息引起的）',
    `时间：${fullTime(d.at)}`,
    `留言链：第 ${d.depth} 层，上限 ${d.limit} 层`,
    '这一轮你写的文字不会发到你的聊天里：回复对方用 qq_message_agent，要让你这边的聊天看到，用 qq_say。',
    '</turn_context>',
    `<conversation_message from="${d.from.key}">`,
    neutralize(d.text),
    '</conversation_message>',
  ].join('\n')
}
