/**
 * QQ protocol layer: credentials, access control, the official Bot API, the
 * gateway WebSocket, and inline keyboards.
 *
 * Everything here is transport — it knows nothing about Claude. The bridge
 * wires it to the agent.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

export function buildAskKeyboard(
  questionId: string,
  options: string[],
): { keyboard: Record<string, unknown>; useLetters: boolean } {
  const longest = Math.max(...options.map(o => o.length))
  const useLetters = longest > LABEL_CEILING
  const perRow = useLetters ? Math.min(4, options.length) : longest <= 3 ? 4 : longest <= 8 ? 2 : 1

  const specs = options.map((opt, i) => ({
    label: useLetters ? LETTERS[i] : opt,
    visited: useLetters ? `${LETTERS[i]} ✓` : `${opt} ✓`,
    style: 1,
    data: `ask:${questionId}:${i}`,
  }))
  return { keyboard: keyboardFrom(`ask:${questionId}`, specs, perRow), useLetters }
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
