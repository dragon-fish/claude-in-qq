/**
 * QQ protocol layer: credentials, access control, the official Bot API, the
 * gateway WebSocket, and inline keyboards.
 *
 * Everything here is transport — it knows nothing about Claude. The bridge
 * wires it to the agent.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------- paths & env

export const STATE_DIR = process.env.QQ_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'qq')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const ENV_FILE = join(STATE_DIR, '.env')
const LOG_FILE = join(STATE_DIR, 'bridge.log')

export function log(...parts: unknown[]): void {
  const line = `${new Date().toISOString()} ${parts
    .map(p => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ')}\n`
  process.stderr.write(`[qq] ${line}`)
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    appendFileSync(LOG_FILE, line)
  } catch {
    // logging must never take the bridge down
  }
}

/** Minimal .env reader. Values already in the environment win. */
export function loadEnvFile(): void {
  if (!existsSync(ENV_FILE)) return
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[key]) process.env[key] = value
  }
}

loadEnvFile()

const APP_ID = process.env.QQ_APP_ID
const CLIENT_SECRET = process.env.QQ_CLIENT_SECRET
const SANDBOX = process.env.QQ_SANDBOX === '1'

export const HAS_CREDENTIALS = Boolean(APP_ID && CLIENT_SECRET)

const API_BASE = SANDBOX ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com'
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'

/**
 * C2C_MESSAGE_CREATE rides on GROUP_AND_C2C_EVENT (1 << 25); INTERACTION
 * (1 << 26) delivers inline-keyboard clicks. Guild and group intents stay off.
 */
const INTENTS = (1 << 25) | (1 << 26)

// -------------------------------------------------------------- access control

type Pending = { openid: string; expires_at: number }

export type Access = {
  policy: 'allowlist' | 'open'
  allowed: string[]
  pending: Record<string, Pending>
}

export const PAIRING_TTL_MS = 10 * 60 * 1000

/** Read access state. A missing or corrupt file means "deny everyone", never "allow". */
export function loadAccess(): Access {
  try {
    const raw = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Partial<Access>
    return {
      policy: raw.policy === 'open' ? 'open' : 'allowlist',
      allowed: Array.isArray(raw.allowed) ? raw.allowed.filter(x => typeof x === 'string') : [],
      pending:
        typeof raw.pending === 'object' && raw.pending ? (raw.pending as Record<string, Pending>) : {},
    }
  } catch (err) {
    if (existsSync(ACCESS_FILE)) log('access.json unreadable, denying all:', err)
    return { policy: 'allowlist', allowed: [], pending: {} }
  }
}

export function saveAccess(a: Access): void {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(ACCESS_FILE, JSON.stringify(a, null, 2), { mode: 0o600 })
}

export function dropExpiredPending(a: Access): void {
  const now = Date.now()
  for (const [code, entry] of Object.entries(a.pending)) {
    if (entry.expires_at <= now) delete a.pending[code]
  }
}

export function isAllowed(openid: string): boolean {
  const access = loadAccess()
  return access.policy === 'open' || access.allowed.includes(openid)
}

/** Codes and ids use lowercase letters without 'l', unambiguous when typed on a phone. */
export const CODE_ALPHABET = 'abcdefghijkmnopqrstuvwxyz'

export function randomId(len = 5): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  return Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
}

// ------------------------------------------------------------------- QQ client

let accessToken = ''
let tokenExpiresAt = 0

async function ensureToken(): Promise<string> {
  if (accessToken && Date.now() < tokenExpiresAt - 60_000) return accessToken
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: APP_ID, clientSecret: CLIENT_SECRET }),
  })
  if (!res.ok) throw new Error(`token request failed: ${res.status} ${await res.text()}`)
  const data = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!data.access_token) throw new Error(`token response missing access_token`)
  accessToken = data.access_token
  tokenExpiresAt = Date.now() + (data.expires_in ?? 7200) * 1000
  return accessToken
}

async function qqFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await ensureToken()
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `QQBot ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
}

// -------------------------------------------------------------- passive quota
//
// A C2C reply carrying msg_id is "passive": free, but capped at 4 uses per
// inbound message and valid for 60 minutes. Past either bound it must go out
// as "active", which draws on a separate daily allowance.

const PASSIVE_MAX_USES = 4
const PASSIVE_TTL_MS = 60 * 60 * 1000

const passiveQuota = new Map<string, { used: number; firstAt: number }>()

function claimPassive(msgId: string | undefined): string | null {
  if (!msgId) return null
  const now = Date.now()
  const entry = passiveQuota.get(msgId)
  if (!entry) {
    passiveQuota.set(msgId, { used: 1, firstAt: now })
    return msgId
  }
  if (entry.used >= PASSIVE_MAX_USES || now - entry.firstAt >= PASSIVE_TTL_MS) return null
  entry.used += 1
  return msgId
}

setInterval(() => {
  const now = Date.now()
  for (const [id, e] of passiveQuota) {
    if (e.used >= PASSIVE_MAX_USES || now - e.firstAt >= PASSIVE_TTL_MS) passiveQuota.delete(id)
  }
}, 5 * 60 * 1000).unref?.()

/** Newest inbound msg_id per sender, so mid-task pushes can still ride passive quota. */
export const lastInboundMsgId = new Map<string, string>()

// -------------------------------------------------------------- relayed notes
//
// `notify` runs as its own process and cannot reach the bridge's memory, so it
// leaves a note on disk instead. The bridge folds it into the next message it
// sends the agent, which is how the agent learns that a message it did not
// write went out over its own channel — otherwise the operator refers back to
// something the agent has no record of.

const RELAY_FILE = join(STATE_DIR, 'relayed.jsonl')

export type RelayedNote = { at: number; from: string; cwd: string; text: string }

export function appendRelayed(note: RelayedNote): void {
  mkdirSync(STATE_DIR, { recursive: true })
  appendFileSync(RELAY_FILE, `${JSON.stringify(note)}\n`)
}

/** Read and clear pending notes. Renames first so a concurrent append is not lost. */
export function drainRelayed(): RelayedNote[] {
  if (!existsSync(RELAY_FILE)) return []
  const taken = `${RELAY_FILE}.draining`
  try {
    renameSync(RELAY_FILE, taken)
    const notes = readFileSync(taken, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap(line => {
        try {
          return [JSON.parse(line) as RelayedNote]
        } catch {
          return []
        }
      })
    unlinkSync(taken)
    return notes
  } catch {
    return []
  }
}

// ------------------------------------------------------------------- outbound

const MAX_CHUNK = 1500

function chunkText(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text]
  const chunks: string[] = []
  let buf = ''
  for (const line of text.split('\n')) {
    if (buf && buf.length + line.length + 1 > MAX_CHUNK) {
      chunks.push(buf)
      buf = ''
    }
    if (line.length > MAX_CHUNK) {
      if (buf) {
        chunks.push(buf)
        buf = ''
      }
      for (let i = 0; i < line.length; i += MAX_CHUNK) chunks.push(line.slice(i, i + MAX_CHUNK))
      continue
    }
    buf = buf ? `${buf}\n${line}` : line
  }
  if (buf) chunks.push(buf)
  return chunks
}

let msgSeq = 1

/**
 * Send to a QQ user. Passive when quota allows, active otherwise.
 *
 * Everything goes out as markdown (msg_type 2). QQ renders the full common
 * subset — bold, italic, inline code, headings, ordered and unordered lists,
 * fenced code, links, even tables — and an inline keyboard only renders on a
 * markdown message at all, so there is no reason to send anything else.
 *
 * The one cost is that underscores and asterisks inside bare identifiers are
 * read as formatting (`src/__init__.py` turns italic). Callers writing such
 * text wrap it in backticks; the operator prompt tells Claude to do the same.
 */
export async function sendToQQ(
  openid: string,
  text: string,
  replyTo?: string,
  keyboard?: Record<string, unknown>,
): Promise<void> {
  await beforeSend()
  const chunks = chunkText(text)

  for (const [i, chunk] of chunks.entries()) {
    const passiveId = claimPassive(replyTo)
    const body: Record<string, unknown> = {
      markdown: { content: chunk },
      msg_type: 2,
      msg_seq: msgSeq++,
    }
    if (passiveId) body.msg_id = passiveId
    if (keyboard && i === chunks.length - 1) body.keyboard = keyboard

    const res = await qqFetch(`/v2/users/${openid}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const detail = await res.text()
      log(`send failed [${res.status}] passive=${Boolean(passiveId)}:`, detail.slice(0, 300))
      throw new Error(`QQ send failed: ${res.status}`)
    }
  }
}

// ------------------------------------------------------------------ streaming
//
// A streamed reply is one QQ message that keeps growing, rather than a series of
// messages. That matters for more than looks: a long answer used to be chopped
// into 1500-character posts, each spending one of the four passive replies an
// inbound message is worth. Streamed, the whole answer costs one.
//
// The protocol is a handshake then appends: the first POST carries msg_id and
// index 0 and comes back with an id; every later POST quotes that id and
// increments index; input_state 10 closes it. `input_mode` defaults to append,
// so each call sends only what is new.

/**
 * Run before every standalone message, whatever sends it.
 *
 * A QQ conversation is strictly linear: a message occupies the position it was
 * posted at, and nothing that arrives later can appear above it. A stream, on
 * the other hand, keeps writing into the position it started at. So anything
 * that posts a new message while a stream is open leaves that stream growing
 * *above* it — from the reader's side, a message they have already scrolled
 * past starts editing itself.
 *
 * Registering the seal here rather than calling it from each sender makes that
 * an invariant instead of a habit: a new sender added later cannot forget.
 */
let beforeSend: () => Promise<void> = async () => {}

export function onBeforeSend(fn: () => Promise<void>): void {
  beforeSend = fn
}

export type StreamHandle = {
  /** Append text. Silently becomes a no-op once the stream has failed. */
  write(text: string): Promise<void>
  /** Close the stream. Safe to call when nothing was ever written. */
  end(): Promise<void>
  /** True once QQ has accepted a first chunk — i.e. the reply is on screen. */
  readonly live: boolean
  /** True if QQ rejected something; the caller should fall back to sendToQQ. */
  readonly failed: boolean
  /**
   * True once QQ reports this message is nearly out of room. The caller should
   * close it and open another rather than write into a message that will start
   * rejecting appends — one growing message still has a maximum length, and a
   * turn long enough to reach it would otherwise lose its own conclusion.
   */
  readonly full: boolean
}

/**
 * How little headroom QQ has to report before a stream is treated as full.
 *
 * Observed behaviour: every append comes back with `remain_msg_len: 0`,
 * whatever the message actually holds — so zero means "not reported", not
 * "no room left". Reading it literally rolled the stream on every single
 * chunk and chopped one reply into a message per line. Only a positive value
 * is believed.
 */
const STREAM_TAIL_MARGIN = 512

/**
 * The fallback ceiling, counted here rather than asked for. Nothing in the
 * response says how large a streamed message may grow, so this is a guess on
 * the safe side of one — a reply that rolls a message early costs one extra
 * message; a reply that never rolls loses its ending.
 */
const STREAM_MAX_CHARS = 4000

/**
 * Smallest gap between two appends on one stream.
 *
 * Writes arrive per finished line, so an unthrottled reply from a fast model
 * is dozens of requests a second. A ceiling here makes that rate a constant
 * rather than a function of how quickly the model happens to generate.
 *
 * Tuned down by eye: 300ms was plainly steppy, 100ms still read worse than
 * no throttle at all. This is a floor on the gap between two requests, not a
 * fixed cadence — when a round trip takes longer than the interval, the next
 * batch simply goes out when the previous one lands.
 *
 * QQ documents a per-bot ceiling far above this, so the remaining reason to
 * throttle is not the limit but the shape: it keeps the request rate a
 * property of the transport rather than of how fast the model generates.
 */
const STREAM_THROTTLE_MS = 22

export function createStream(openid: string, replyTo?: string): StreamHandle {
  let streamId: string | null = null
  let index = 0
  let full = ''
  /** Serializes the appends: QQ orders by `index`, so they must not interleave. */
  let chain: Promise<void> = Promise.resolve()

  // Every chunk repeats the same msg_id and msg_seq — the reference request in
  // the docs does, and dropping msg_id after the first chunk earns a 500. That
  // also means streaming is only ever a *reply*: with no inbound message to
  // answer, there is nothing to open a stream against, so this reports failure
  // immediately and the caller sends the ordinary way.
  const passiveId = claimPassive(replyTo)
  const seq = msgSeq++
  let failed = !passiveId
  /** Distinct from `full`, which is the accumulated text this stream has sent. */
  let nearlyFull = false
  /** Log the reported capacity once per stream, not once per append. */
  let sawRemaining = false
  /** Written but not yet sent, waiting for the throttle window to close. */
  let pending = ''
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  /** True while a request is in flight, so batches never queue behind it. */
  let sending = false
  let lastSentAt = 0

  /** Round-trip samples, so the append rate can be attributed rather than guessed. */
  let sentCount = 0
  let sentMs = 0
  let slowestMs = 0

  async function send(closing: boolean, delta: string): Promise<void> {
    if (failed) return
    const startedAt = Date.now()
    // Append while generating, replace once at the end.
    //
    // Replacing every time would resend the whole reply with every line — the
    // traffic grows with the square of the length, and the requests get slower
    // exactly as the answer gets longer. Appending sends each line once.
    //
    // The closing replace is a reconciliation: it states the finished text in
    // full, so what ended up on the screen is checked against what was meant.
    // A mismatch surfaces as 40007 rather than as a reply quietly missing a
    // paragraph. It cannot repair a lost chunk — replace demands that the new
    // text begin with what was already delivered — but it does make the loss
    // visible in the log.
    const res = await qqFetch(`/v2/users/${openid}/stream_messages`, {
      method: 'POST',
      body: JSON.stringify({
        input_mode: closing ? 'replace' : 'append',
        input_state: closing ? 10 : 1,
        index: index++,
        content_type: 'markdown',
        content_raw: closing ? full : delta,
        msg_id: passiveId,
        msg_seq: seq,
        ...(streamId ? { stream_msg_id: streamId } : {}),
      }),
    })
    if (!res.ok) {
      failed = true
      // The length is the point of this line. QQ will not say how large a
      // streamed message may grow — remain_msg_len is always 0 — and then
      // answers 50001 once it has had enough. Recording how much was in it
      // each time this happens is the only way to find the real ceiling and
      // set STREAM_MAX_CHARS under it, so the stream rolls to a new message
      // deliberately instead of being cut off and falling back to chunks.
      log(
        `stream ${streamId ? 'append' : 'open'} failed [${res.status}] at ${full.length} chars, ` +
          `chunk ${index}:`,
        (await res.text()).slice(0, 200),
      )
      return
    }
    const data = (await res.json()) as { id?: string; remain_msg_len?: number }
    if (!streamId && data.id) streamId = data.id
    const took = Date.now() - startedAt
    sentCount += 1
    sentMs += took
    if (took > slowestMs) slowestMs = took
    if (typeof data.remain_msg_len === 'number' && data.remain_msg_len > 0) {
      if (!sawRemaining) {
        sawRemaining = true
        log(`stream capacity: remain_msg_len=${data.remain_msg_len} after ${index} chunk(s)`)
      }
      if (data.remain_msg_len <= STREAM_TAIL_MARGIN) nearlyFull = true
    }
    if (full.length >= STREAM_MAX_CHARS) nearlyFull = true
  }

  /**
   * Appends are coalesced on a timer rather than sent per write.
   *
   * A write happens per finished line, so an unthrottled long reply is a
   * hundred-odd requests in a couple of minutes — needless load, and the most
   * likely explanation for the burst of 50001s, which arrived in a cluster
   * and then never again.
   */
  function scheduleFlush(): void {
    if (flushTimer || sending || failed) return
    const since = Date.now() - lastSentAt
    flushTimer = setTimeout(
      () => {
        flushTimer = null
        flushPending()
      },
      Math.max(0, STREAM_THROTTLE_MS - since),
    )
  }

  function flushPending(): void {
    if (!pending || failed || sending) return
    const chunk = pending
    pending = ''
    sending = true
    chain = chain
      .then(async () => {
        await send(false, chunk)
        lastSentAt = Date.now()
      })
      .catch(err => {
        failed = true
        log('stream write threw:', err)
      })
      .finally(() => {
        sending = false
        // Anything written while that request was in flight goes next, spaced
        // from it by the same interval — so a slow round trip degrades into
        // "send the next batch when this one lands" instead of a queue that
        // grows faster than it drains.
        if (pending) scheduleFlush()
      })
  }

  return {
    get live() {
      return streamId !== null && !failed
    },
    get failed() {
      return failed
    },
    get full() {
      return nearlyFull
    },
    write(text: string) {
      if (!text || failed) return chain
      full += text
      pending += text
      scheduleFlush()
      return chain
    },
    end() {
      // Whatever is still waiting on the timer goes first, in order.
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      flushPending()
      chain = chain
        .then(async () => {
          // Nothing was ever sent, so there is no stream to close.
          if (!streamId || failed) return
          await send(true, '')
          if (sentCount) {
            log(
              `stream done: ${sentCount} appends, ${full.length} chars, ` +
                `avg ${Math.round(sentMs / sentCount)}ms, slowest ${slowestMs}ms`,
            )
          }
        })
        .catch(err => {
          failed = true
          log('stream end threw:', err)
        })
      return chain
    },
  }
}

// --------------------------------------------------------------- command panel
//
// The panel is what QQ shows when the operator taps the "/" affordance. Tapping
// an entry types its name into the input box rather than sending it, so a name
// of "/status" arrives here as an ordinary slash command and needs no special
// handling on the way in.
//
// Panels are per-application and capped at 20, so this syncs rather than
// creates: an existing panel carrying our remark is updated in place. Creating
// one per restart would exhaust the allowance in a fortnight.

const PANEL_REMARK = 'claude-in-qq'
const PANEL_NAME_MAX = 14
const PANEL_DESC_MAX = 30

export type PanelEntry = { name: string; desc: string }

/** QQ counts a CJK character as two. Truncate on that budget, not on length. */
function fitWidth(s: string, max: number): string {
  let width = 0
  let out = ''
  for (const ch of s) {
    const w = /[⺀-鿿豈-﫿＀-￯]/.test(ch) ? 2 : 1
    if (width + w > max) return `${out.slice(0, -1)}…`
    width += w
    out += ch
  }
  return out
}

/**
 * Create or update the C2C command panel. Returns the panel id.
 *
 * `version` is bumped on every update because QQ uses it to decide whether
 * clients need to refetch; leaving it fixed leaves stale panels on phones.
 */
export async function syncCommandPanel(entries: PanelEntry[]): Promise<string> {
  const items = entries.slice(0, 20).map(e => ({
    name: fitWidth(e.name, PANEL_NAME_MAX),
    desc: fitWidth(e.desc, PANEL_DESC_MAX),
    type: 'command',
  }))

  const listed = await qqFetch('/v2/panels?scope=c2c')
  if (!listed.ok) throw new Error(`查询面板失败 ${listed.status}: ${(await listed.text()).slice(0, 200)}`)
  // The list comes back under `records`, not `panels`; getting this wrong makes
  // every sync look like a first sync and burns through the 20-panel allowance.
  const { records = [] } = (await listed.json()) as {
    records?: { panel_id: string; panel?: { remark?: string; version?: number } }[]
  }
  const mine = records.find(p => p.panel?.remark === PANEL_REMARK)

  const panel = {
    items,
    remark: PANEL_REMARK,
    version: (mine?.panel?.version ?? 0) + 1,
  }

  const res = mine
    ? await qqFetch(`/v2/panels/${mine.panel_id}`, {
        method: 'PUT',
        body: JSON.stringify({ scope: 'c2c', panel }),
      })
    : await qqFetch('/v2/panels', {
        method: 'POST',
        body: JSON.stringify({ scope: 'c2c', target_type: 'all', panel }),
      })

  if (!res.ok) throw new Error(`${mine ? '更新' : '创建'}面板失败 ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const body = (await res.json()) as { panel_id?: string }
  return body.panel_id ?? mine!.panel_id
}

/** List existing C2C panels, for inspection and cleanup. */
export async function listCommandPanels(): Promise<
  { panel_id: string; remark?: string; items: number }[]
> {
  const res = await qqFetch('/v2/panels?scope=c2c')
  if (!res.ok) throw new Error(`查询面板失败 ${res.status}`)
  const { records = [] } = (await res.json()) as {
    records?: { panel_id: string; panel?: { remark?: string; items?: unknown[] } }[]
  }
  return records.map(p => ({
    panel_id: p.panel_id,
    remark: p.panel?.remark,
    items: p.panel?.items?.length ?? 0,
  }))
}

export async function deleteCommandPanel(panelId: string): Promise<void> {
  const res = await qqFetch(`/v2/panels/${panelId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`删除面板失败 ${res.status}: ${(await res.text()).slice(0, 200)}`)
}

// ------------------------------------------------------------------ keyboards
//
// Buttons split their row evenly, so the label budget shrinks as the row fills:
// roughly 2 chars at 4-per-row, 6 at 2-per-row, ~20 for a full-width button.
// The real limit moves with screen size, so 20 is a ceiling, not a target.

export const LABEL_CEILING = 20
export const LETTERS = 'ABCDEFGH'

type ButtonSpec = { label: string; visited: string; style: number; data: string }

function keyboardFrom(groupId: string, buttons: ButtonSpec[], perRow: number): Record<string, unknown> {
  const built = buttons.map((b, i) => ({
    id: `b${i}`,
    render_data: { label: b.label, visited_label: b.visited, style: b.style },
    // action.type 1 is Callback — it delivers button_data via INTERACTION_CREATE.
    // type 2 would be a plain link and would never reach us.
    action: { type: 1, data: b.data, permission: { type: 2 }, click_limit: 1 },
    group_id: groupId,
  }))
  const rows: unknown[] = []
  for (let i = 0; i < built.length; i += perRow) rows.push({ buttons: built.slice(i, i + perRow) })
  return { content: { rows } }
}

export function buildApprovalKeyboard(requestId: string): Record<string, unknown> {
  return keyboardFrom(
    `approve:${requestId}`,
    [
      { label: '✅ 允许', visited: '已允许', style: 1, data: `approve:${requestId}:allow` },
      { label: '❌ 拒绝', visited: '已拒绝', style: 0, data: `approve:${requestId}:deny` },
    ],
    2,
  )
}

export type AskLayout = {
  keyboard: Record<string, unknown>
  /**
   * How much meaning the buttons carry by themselves:
   *   'text'      — full option text is on the button; the message needs no list
   *   'truncated' — shortened but still recognisable; list the full text
   *   'letters'   — buttons say A/B/C; the list must carry the meaning
   */
  mode: 'text' | 'truncated' | 'letters'
}

function rowsFor(longest: number): number {
  return longest <= 3 ? 4 : longest <= 8 ? 2 : 1
}

/**
 * A button that reads "重写" is worth more than one that reads "B", so letters
 * are the last resort rather than the response to any option being long. An
 * option past the label ceiling is shortened first, and letters appear only
 * when shortening makes two options indistinguishable.
 */
export function buildAskKeyboard(questionId: string, options: string[]): AskLayout {
  const build = (labels: string[], perRow: number) =>
    keyboardFrom(
      `ask:${questionId}`,
      labels.map((label, i) => ({
        label,
        visited: `${label} ✓`,
        style: 1,
        data: `ask:${questionId}:${i}`,
      })),
      perRow,
    )

  const longest = Math.max(...options.map(o => o.length))
  if (longest <= LABEL_CEILING) {
    return { keyboard: build(options, rowsFor(longest)), mode: 'text' }
  }

  const short = options.map(o => (o.length <= LABEL_CEILING ? o : `${o.slice(0, LABEL_CEILING - 1)}…`))
  if (new Set(short).size === short.length) {
    return { keyboard: build(short, rowsFor(Math.max(...short.map(s => s.length)))), mode: 'truncated' }
  }

  const letters = options.map((_, i) => LETTERS[i])
  return { keyboard: build(letters, Math.min(4, options.length)), mode: 'letters' }
}

// --------------------------------------------------------------------- media

/** Anthropic rejects images past ~5MB; fetching more than this is wasted work. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
}

/**
 * Fetch an inbound image and return it base64-encoded, or null when it cannot
 * be used. QQ's CDN links are short-lived and unauthenticated to the model, so
 * passing the URL through would leave Claude unable to see what was sent.
 */
export async function fetchImage(
  url: string,
  contentType?: string,
): Promise<{ data: string; mediaType: string } | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) {
      log(`image fetch failed [${res.status}]`)
      return null
    }

    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      log(`image too large (${buf.byteLength} bytes), skipping`)
      return null
    }

    // Trust the response header first, then the URL's extension; QQ often
    // serves images from extensionless paths.
    const header = (contentType ?? res.headers.get('content-type') ?? '').split(';')[0].trim()
    const ext = new URL(url).pathname.split('.').pop()?.toLowerCase() ?? ''
    const mediaType = header.startsWith('image/')
      ? header
      : (IMAGE_MEDIA_TYPES[ext] ?? 'image/jpeg')

    return { data: buf.toString('base64'), mediaType }
  } catch (err) {
    log('image fetch error:', err)
    return null
  }
}

/** QQ media kinds for the upload endpoint. */
const MEDIA_IMAGE = 1
const MEDIA_VIDEO = 2
const MEDIA_FILE = 4

/** Uploads are capped well below the API limit; a huge file is a mistake, not a message. */
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024

function mediaKind(path: string): number {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (ext in IMAGE_MEDIA_TYPES) return MEDIA_IMAGE
  if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) return MEDIA_VIDEO
  return MEDIA_FILE
}

/**
 * Send a local file as a native QQ attachment.
 *
 * Two steps rather than one: uploading with `srv_send_msg: true` would have QQ
 * deliver it immediately, but then the message carries no msg_id and cannot use
 * the passive quota. Uploading first and sending second keeps that control.
 */
export async function sendFile(
  openid: string,
  path: string,
  replyTo?: string,
  caption?: string,
): Promise<void> {
  await beforeSend()
  const buf = readFileSync(path)
  if (buf.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(`文件太大（${Math.round(buf.byteLength / 1024 / 1024)}MB）`)
  }

  const kind = mediaKind(path)
  const body: Record<string, unknown> = {
    file_type: kind,
    srv_send_msg: false,
    file_data: buf.toString('base64'),
  }
  if (kind === MEDIA_FILE) body.file_name = path.split('/').pop()

  const upload = await qqFetch(`/v2/users/${openid}/files`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!upload.ok) throw new Error(`上传失败 ${upload.status}: ${(await upload.text()).slice(0, 200)}`)

  const { file_info } = (await upload.json()) as { file_info?: string }
  if (!file_info) throw new Error('上传响应里没有 file_info')

  const passiveId = claimPassive(replyTo)
  const send: Record<string, unknown> = { msg_type: 7, media: { file_info }, msg_seq: msgSeq++ }
  // A media message takes plain-text `content` as a caption, so a short note
  // rides along with the file instead of arriving as a separate message.
  // Markdown is not rendered here, which is why long prose still goes on its own.
  if (caption) send.content = caption.slice(0, MAX_CHUNK)
  if (passiveId) send.msg_id = passiveId

  const res = await qqFetch(`/v2/users/${openid}/messages`, {
    method: 'POST',
    body: JSON.stringify(send),
  })
  if (!res.ok) throw new Error(`发送失败 ${res.status}: ${(await res.text()).slice(0, 200)}`)
}

// -------------------------------------------------------------------- gateway

export type InboundMessage = {
  id: string
  content: string
  openid: string
  attachments: { url?: string; content_type?: string; filename?: string }[]
}

export type GatewayHandlers = {
  onMessage: (msg: InboundMessage) => Promise<void>
  onButton: (openid: string, buttonData: string) => Promise<void>
}

const gw = {
  ws: null as WebSocket | null,
  seq: null as number | null,
  sessionId: null as string | null,
  heartbeat: null as ReturnType<typeof setInterval> | null,
  closed: false,
}

async function getGatewayUrl(): Promise<string> {
  const res = await qqFetch('/gateway')
  if (!res.ok) throw new Error(`gateway lookup failed: ${res.status}`)
  const data = (await res.json()) as { url?: string }
  if (!data.url) throw new Error('gateway response missing url')
  return data.url
}

/** ACK an interaction promptly or QQ shows an error indicator on the button. */
async function ackInteraction(id: string): Promise<void> {
  try {
    const res = await qqFetch(`/interactions/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ code: 0 }),
    })
    if (!res.ok) log(`interaction ack failed [${res.status}]`)
  } catch (err) {
    log('interaction ack error:', err)
  }
}

export async function connectGateway(handlers: GatewayHandlers, attempt = 0): Promise<void> {
  if (gw.closed) return
  try {
    const url = await getGatewayUrl()
    const token = await ensureToken()
    const ws = new WebSocket(url)
    gw.ws = ws

    ws.addEventListener('open', () => log('gateway connected'))

    ws.addEventListener('message', async event => {
      let payload: { op: number; d?: any; s?: number; t?: string }
      try {
        payload = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (typeof payload.s === 'number') gw.seq = payload.s

      if (payload.op === 10) {
        const interval = payload.d?.heartbeat_interval ?? 30_000
        if (gw.heartbeat) clearInterval(gw.heartbeat)
        gw.heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 1, d: gw.seq }))
        }, Math.max(5_000, interval * 0.8))

        ws.send(
          JSON.stringify(
            gw.sessionId && gw.seq !== null
              ? { op: 6, d: { token: `QQBot ${token}`, session_id: gw.sessionId, seq: gw.seq } }
              : {
                  op: 2,
                  d: {
                    token: `QQBot ${token}`,
                    intents: INTENTS,
                    shard: [0, 1],
                    properties: { $os: 'darwin', $browser: 'claude-qq-bridge', $device: 'claude-qq-bridge' },
                  },
                },
          ),
        )
        return
      }

      if (payload.op === 7 || payload.op === 9) {
        if (payload.op === 9) {
          gw.sessionId = null
          gw.seq = null
        }
        ws.close()
        return
      }

      if (payload.op !== 0 || !payload.t) return
      const d = payload.d ?? {}

      if (payload.t === 'READY') {
        gw.sessionId = d.session_id ?? null
        log('ready, session', gw.sessionId)
        return
      }
      if (payload.t === 'RESUMED') {
        log('session resumed')
        return
      }

      if (payload.t === 'C2C_MESSAGE_CREATE') {
        const openid = d.author?.user_openid
        if (!openid || !d.id) return
        try {
          await handlers.onMessage({
            id: String(d.id),
            content: String(d.content ?? '').trim(),
            openid: String(openid),
            attachments: Array.isArray(d.attachments) ? d.attachments : [],
          })
        } catch (err) {
          log('inbound handling failed:', err)
        }
        return
      }

      if (payload.t === 'INTERACTION_CREATE') {
        const id = d.id ? String(d.id) : ''
        if (id) await ackInteraction(id)
        const openid = String(d.user_openid ?? d.author?.user_openid ?? d.author?.member_openid ?? '')
        const buttonData = String(d.data?.resolved?.button_data ?? '')
        try {
          await handlers.onButton(openid, buttonData)
        } catch (err) {
          log('interaction handling failed:', err)
        }
      }
    })

    ws.addEventListener('close', () => {
      if (gw.heartbeat) clearInterval(gw.heartbeat)
      gw.heartbeat = null
      if (gw.closed) return
      const delay = Math.min(60_000, 2000 * 2 ** attempt)
      log(`gateway closed, reconnecting in ${delay}ms`)
      setTimeout(() => void connectGateway(handlers, attempt + 1), delay)
    })

    ws.addEventListener('error', err => log('gateway error:', err))
  } catch (err) {
    if (gw.closed) return
    const delay = Math.min(60_000, 2000 * 2 ** attempt)
    log('gateway setup failed, retrying in', delay, 'ms:', err)
    setTimeout(() => void connectGateway(handlers, attempt + 1), delay)
  }
}

export function closeGateway(): void {
  gw.closed = true
  if (gw.heartbeat) clearInterval(gw.heartbeat)
  gw.ws?.close()
}
