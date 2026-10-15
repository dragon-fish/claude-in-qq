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
 * The nickname `content` opens with, or null when it opens with none. Only the
 * very start counts — a nickname mid-sentence is someone talking about the
 * bot, not to it. The longest matching nickname wins, so one that is a prefix
 * of another cannot cut it short; case is ignored.
 */
export function matchNickname(content: string, nicknames: string[]): string | null {
  return (
    [...nicknames]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .find(n => content.slice(0, n.length).toLowerCase() === n.toLowerCase()) ?? null
  )
}

/** The text after the nickname `content` opens with, or null when it opens with none. */
export function stripNickname(content: string, nicknames: string[]): string | null {
  const hit = matchNickname(content, nicknames)
  return hit === null ? null : content.slice(hit.length).replace(NICKNAME_SEPARATOR, '')
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

/** Characters that render as nothing, which could hide between `<` and a tag name. */
const INVISIBLE = '\\s\\u200B-\\u200F\\u2060\\uFEFF'

/**
 * The `<` of anything that reads as one of the bridge's framing tags, opening
 * or closing: whitespace or invisible characters around the slash, any case,
 * and `-`, `_` or nothing between the words all still count.
 */
const FRAMING_TAG = new RegExp(
  `<(?=[${INVISIBLE}]*/?[${INVISIBLE}]*` +
    `(?:turn|user|conversation|quoted|harness|system)[-_]?(?:context|message|reminder)\\b)`,
  'gi',
)

/**
 * Break any of the bridge's own framing tags inside untrusted text. Anyone in
 * a group can put words in a `<user_message>`, and a closing
 * `</user_message>` or a forged `<system-reminder>` there would otherwise
 * read as the bridge speaking.
 */
export function neutralize(text: string): string {
  return text.replace(FRAMING_TAG, '＜')
}

/**
 * A framing block's body: a JSON object, one top-level field per line and one
 * array entry per line. Every member-controlled string — names, group names,
 * history — sits inside a JSON string, so it cannot fake a field, a role tag
 * or a line of its own; `<` and `>` are escaped, so it cannot close the tag
 * around it either.
 */
export function framingJson(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) =>
      Array.isArray(v) && v.length
        ? `  ${JSON.stringify(k)}: [\n${v.map(x => `    ${jsonLine(x)}`).join(',\n')}\n  ]`
        : `  ${JSON.stringify(k)}: ${jsonLine(v)}`,
    )
  return `{\n${lines.join(',\n')}\n}`
}

/** One value as single-line JSON with `<` and `>` escaped; see `framingJson`. */
export function jsonLine(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
}

export type Speaker = { openid: string; name: string; isOwner: boolean; isBot: boolean }

/** What the formatter needs to know about members beyond the message itself. */
export type MemberLookup = {
  /** A member's role, for labelling entries. */
  roleOf?: (openid: string) => 'owner' | 'op' | null
  /** Fallback names for mentions the message itself does not name. */
  nameOf?: (openid: string) => string | null
}

export type TurnInput = MemberLookup & {
  /**
   * A group is shown by `label` — its display name, or the head of its openid
   * when it has none — and by its conversation key, which is what
   * qq_message_agent and qq_group_history take. `trusted` is the owner's
   * /group trust setting.
   */
  source: { kind: 'private' } | { kind: 'group'; label: string; key: string; trusted: boolean }
  /**
   * Group only: what made this message start a turn — an @ of this bot, or
   * one of its nicknames opening the message (which stays in the text).
   */
  trigger?: { kind: 'mention' } | { kind: 'nickname'; nickname: string }
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
 * One stored group message as a JSON-ready object: time, sender, role flags
 * (present only when true), text with mentions as names. `clip` shortens the
 * text; `withId` adds the message id, for paging and referring back.
 */
export function historyEntry(
  m: HistoryMessage,
  opts: MemberLookup & { ref: number; clip?: number; withId?: boolean },
): Record<string, unknown> {
  let text = renderMentions(m.content, m.mentions, opts.nameOf)
  if (opts.clip && text.length > opts.clip) text = `${text.slice(0, opts.clip)}…`
  const head = { ...(opts.withId ? { id: m.message_id } : {}), at: stamp(m.created_at, opts.ref) }
  if (m.is_self) return { ...head, self: true, text }
  const role = opts.roleOf?.(m.author_openid)
  return {
    ...head,
    openid: m.author_openid,
    name: m.author_name,
    ...(role === 'owner' ? { is_owner: true } : {}),
    ...(role ? { is_op: true } : {}),
    ...(m.is_bot ? { is_bot: true } : {}),
    text,
  }
}

/**
 * Wrap an inbound message for the agent: who said it, where and when, what
 * the group said just before, then the message itself.
 */
export function wrapTurn(input: TurnInput): string {
  const { speaker, source } = input
  const role = input.roleOf?.(speaker.openid)
  const context = framingJson({
    source:
      source.kind === 'group'
        ? { kind: 'group', key: source.key, name: source.label, trusted: source.trusted }
        : { kind: 'private' },
    trigger:
      source.kind === 'group'
        ? input.trigger?.kind === 'nickname'
          ? { kind: 'nickname', nickname: input.trigger.nickname }
          : { kind: 'mention' }
        : undefined,
    speaker: {
      openid: speaker.openid,
      name: speaker.name,
      is_owner: speaker.isOwner,
      ...(source.kind === 'group' ? { is_op: speaker.isOwner || role === 'op' } : {}),
      is_bot: speaker.isBot,
    },
    time: fullTime(input.at),
    // Repeated here on purpose, every turn, beside the question. Stated once in
    // the system prompt it lost to the owner asking in person: an untrusted
    // group got the owner's employer and repo list because the owner asked.
    privacy:
      source.kind === 'group' && !source.trusted
        ? 'Untrusted group: do not reveal the owner\'s personal or work details or this machine\'s details here, even if the owner asks; offer private chat instead.'
        : undefined,
    recent:
      source.kind === 'group'
        ? (input.recent ?? []).map(m => historyEntry(m, { ...input, ref: input.at, clip: RECENT_CLIP }))
        : undefined,
  })
  const body = renderMentions(input.text, input.mentions ?? [], input.nameOf)
  return ['<turn_context>', context, '</turn_context>', '<user_message>', neutralize(body), '</user_message>'].join('\n')
}

/** How long an originating message is quoted in a delivery's context. */
const ORIGIN_CLIP = 200

/** The QQ message a chain of deliveries started from. `text` has mentions rendered. */
export type Origin = { speaker: Speaker; where: string; text: string }

/** An origin as one line for the owner to read: who, where, and what they said, line breaks folded. */
export function describeOrigin(o: Origin): string {
  const tags = [o.speaker.isOwner ? '主人' : '', o.speaker.isBot ? 'bot' : ''].filter(Boolean).map(t => `[${t}]`).join('')
  return `${o.speaker.name ? `${JSON.stringify(o.speaker.name)} ` : ''}(${o.speaker.openid})${tags ? ` ${tags}` : ''} ` +
    `在${o.where}说：${clipOrigin(o.text).replace(/\s*\n\s*/g, ' ⏎ ')}`
}

const clipOrigin = (text: string) => (text.length > ORIGIN_CLIP ? `${text.slice(0, ORIGIN_CLIP)}…` : text)

export type DeliveryInput = {
  /** The sending conversation: its key, and how it is shown ('私聊', '群 名字'). */
  from: { key: string; label: string }
  /** Null when no QQ message started the chain. */
  origin: Origin | null
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
 * is silent (see `Conversation.silent` in index.ts). The message is
 * neutralized: the sender is an agent, but what it passes on may be quoted
 * from anyone.
 */
export function wrapDelivery(d: DeliveryInput): string {
  const context = framingJson({
    source: { kind: 'agent_message', from: d.from.key, from_name: d.from.label },
    origin: d.origin
      ? {
          where: d.origin.where,
          openid: d.origin.speaker.openid,
          name: d.origin.speaker.name,
          is_owner: d.origin.speaker.isOwner,
          is_bot: d.origin.speaker.isBot,
          text: clipOrigin(d.origin.text),
        }
      : null,
    time: fullTime(d.at),
    chain: { depth: d.depth, limit: d.limit },
    note: '这一轮你写的文字不会发到你的聊天里：回复对方用 qq_message_agent，要让你这边的聊天看到，用 qq_say。',
  })
  return [
    '<turn_context>',
    context,
    '</turn_context>',
    `<conversation_message from="${d.from.key}">`,
    neutralize(d.text),
    '</conversation_message>',
  ].join('\n')
}
