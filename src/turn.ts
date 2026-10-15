/**
 * What reaches the agent: which group messages start a turn, what a command
 * is read from, and how every inbound message is wrapped before the agent
 * sees it.
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

/**
 * A group message starts a turn only when an op — the owner, a listed member,
 * or a listed bot — @'s this bot. Everything else is only recorded.
 */
export function routeGroupMessage(
  msg: InboundGroupMessage,
  isOp: (openid: string) => boolean,
): 'trigger' | 'history' {
  return mentionsMe(msg) && isOp(msg.author.openid) ? 'trigger' : 'history'
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The text a slash command is read from: this bot's own mentions removed,
 * wherever they sit, so `@bot /cwd x` and `/cwd x @bot` both parse.
 */
export function commandText(msg: InboundGroupMessage): string {
  let text = msg.content
  for (const m of msg.mentions) {
    if (m.isYou && m.openid) text = text.replace(new RegExp(`<@!?${escapeRe(m.openid)}>`, 'g'), ' ')
  }
  return text.trim()
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
    /<(\/?)(turn_context|user_message|quoted_message|harness-reminder|system-reminder)/gi,
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
  source: { kind: 'private' } | { kind: 'group'; group: string }
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
  lines.push(input.source.kind === 'group' ? `来源：群 ${input.source.group}` : '来源：私聊')
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
