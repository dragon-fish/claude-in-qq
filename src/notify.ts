#!/usr/bin/env bun
/**
 * Send a one-way message to the operator's QQ, from anywhere on this machine.
 *
 * The bridge is not involved: credentials and the allowlist are files, so any
 * process that can read them can send. That keeps this usable from a Claude
 * Code session in another directory, a script, or a finished build — none of
 * which can talk to the bridge process.
 *
 *   bun run notify "构建完成"
 *   bun run notify --from partymaker-service "测试全绿"
 *   somecommand | bun run notify --from ci
 *   bun run notify --from render "出图了" MEDIA:/tmp/a.png
 *
 * A `MEDIA:/path` line — the same convention the bridge's agent uses — sends
 * that file as a native attachment, so text and files go out in the order
 * they are written. A positional argument that is a whole `MEDIA:` line counts
 * as its own line.
 *
 * Every message is labelled with its origin, because the operator is already
 * chatting with the bridge in that same QQ window and an unattributed line
 * would read as something the bridge's Claude said.
 *
 * These are active messages against a 1000/day account quota, so they are for
 * things worth interrupting someone over, not progress chatter.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  appendRelayed,
  HAS_CREDENTIALS,
  loadAccess,
  MEDIA_LINE_RE,
  sendFile,
  sendToQQ,
  STATE_DIR,
} from './qq.js'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const args = process.argv.slice(2)
let from = ''
const words: string[] = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--from') {
    from = (args[++i] ?? '').trim()
    continue
  }
  words.push(args[i])
}

let text = words.map(w => (/^MEDIA:/.test(w.trim()) ? `\n${w.trim()}\n` : w)).join(' ').trim()
if (!text && !process.stdin.isTTY) text = (await readStdin()).trim()

if (!text) {
  console.error('用法: bun run notify [--from <来源>] <消息>')
  console.error('      <消息> 也可以从 stdin 传入；单独一行 MEDIA:/路径 会作为附件发送')
  process.exit(1)
}

type Segment = { text: string } | { file: string }

/** Prose and attachments in the order written; relative paths resolve against the caller's cwd. */
function toSegments(raw: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of raw.matchAll(MEDIA_LINE_RE)) {
    const prose = raw.slice(last, m.index).trim()
    if (prose) out.push({ text: prose })
    out.push({ file: resolve(m[1]) })
    last = m.index + m[0].length
  }
  const tail = raw.slice(last).trim()
  if (tail) out.push({ text: tail })
  return out
}

const segments = toSegments(text)

// Checked before anything goes out: a missing file discovered halfway would
// leave the operator with the caption and no picture.
const missing = segments.flatMap(s =>
  'file' in s && !(existsSync(s.file) && statSync(s.file).isFile()) ? [s.file] : [],
)
if (missing.length) {
  console.error(`找不到文件: ${missing.join(', ')}`)
  process.exit(1)
}

// Paths resolved, so the rate check and the relayed note see what was sent.
text = segments.map(s => ('file' in s ? `MEDIA:${s.file}` : s.text)).join('\n\n')

if (!HAS_CREDENTIALS) {
  console.error('QQ 凭据缺失，先跑: bun run onboard')
  process.exit(1)
}

const access = loadAccess()
if (!access.allowed.length) {
  console.error('白名单为空，没有可送达的人。给 bot 发条消息拿配对码，再跑 bun run pair <code>')
  process.exit(1)
}

// ------------------------------------------------------------------ rate limit
//
// Not a security boundary — anything that can run this can also read the
// credentials next to it and call the QQ API directly. It catches a runaway
// loop, and the caps are loose because the damage one could do is bounded.
//
// The two quotas are separate pools. Replying to an inbound message spends
// passive quota, budgeted per inbound message (4 within an hour of each), so
// the operator writing in always gets an answer no matter what happened here.
// Only what nobody asked for is active quota, 1000 a day: the tail of a reply
// past its four passive sends, and mid-task progress. Draining it degrades
// those, it does not silence the conversation.
//
// Duplicate detection does most of the work regardless — a loop repeats itself,
// and that is visible in one message rather than a hundred.

const HOURLY_MAX = 30
const DAILY_MAX = 200
const DEDUP_MS = 5 * 60 * 1000
const RATE_FILE = join(STATE_DIR, 'notify-rate.json')

type Sent = { at: number; hash: string }

const digest = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

function loadSent(): Sent[] {
  try {
    const parsed = JSON.parse(readFileSync(RATE_FILE, 'utf8'))
    return Array.isArray(parsed) ? (parsed as Sent[]) : []
  } catch {
    return []
  }
}

const now = Date.now()
const hash = digest(text)
const recent = loadSent().filter(s => now - s.at < 24 * 60 * 60 * 1000)

const lastHour = recent.filter(s => now - s.at < 60 * 60 * 1000).length
const duplicate = recent.find(s => s.hash === hash && now - s.at < DEDUP_MS)

if (duplicate) {
  const ago = Math.round((now - duplicate.at) / 1000)
  console.error(`同样的内容 ${ago} 秒前刚发过，已拦下。如果这是循环，先修循环。`)
  process.exit(1)
}
if (lastHour >= HOURLY_MAX) {
  console.error(`一小时内已发 ${lastHour} 条，达到上限 ${HOURLY_MAX}。`)
  console.error('正常用法一天也就几条，撞到这里通常意味着有什么在自动重发。')
  process.exit(1)
}
if (recent.length >= DAILY_MAX) {
  console.error(`24 小时内已发 ${recent.length} 条，达到上限 ${DAILY_MAX}。`)
  process.exit(1)
}

const cwd = process.cwd().replace(homedir(), '~')
const origin = from || basename(process.cwd())
const header = from
  ? `**${from}**（\`${cwd}\`）下的 Claude 给你留言：`
  : `\`${cwd}\` 下的 Claude 给你留言：`

// The attribution leads whatever comes first; a bare attachment would read as
// something the bridge's agent sent.
const [first, ...rest] = segments
const outgoing: Segment[] =
  'text' in first ? [{ text: `${header}\n\n${first.text}` }, ...rest] : [{ text: header }, ...segments]

let failed = 0
for (const openid of access.allowed) {
  try {
    for (const seg of outgoing) {
      if ('text' in seg) await sendToQQ(openid, seg.text)
      else await sendFile(openid, seg.file)
    }
  } catch (err) {
    failed++
    console.error(`发送给 ${openid.slice(0, 8)} 失败:`, err instanceof Error ? err.message : err)
  }
}

if (failed === access.allowed.length) process.exit(1)

// Counted only once it actually went out, so a failing send cannot exhaust the
// budget — the retry it provokes would otherwise be locked out by its own
// failures.
recent.push({ at: now, hash })
try {
  writeFileSync(RATE_FILE, JSON.stringify(recent), { mode: 0o600 })
} catch {
  // A missing rate file must not stop a message the operator is waiting for.
}

// Tell the bridge's agent what went out on its channel. Without this the
// operator can reply "about that thing just now" to an agent that never saw it.
appendRelayed({ at: now, from: origin, cwd, text })

console.log(`已送达 ${access.allowed.length - failed}/${access.allowed.length}`)
