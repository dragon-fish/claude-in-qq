#!/usr/bin/env bun
/**
 * Scan-to-configure for the QQ channel.
 *
 * Creates a bind task on the QQ portal, shows a QR code, and waits for you to
 * scan it with the QQ app. Scanning provisions the bot application on Tencent's
 * side and hands back the app id, an encrypted client secret, and the openid of
 * whoever scanned — so there is no manual application to file and no separate
 * pairing step: the scanner is the operator.
 *
 * The secret is encrypted to a key generated here and never leaves in plaintext.
 *
 * Run standalone:  bun run onboard.ts
 *
 * NOTE: /lite/create_bind_task and /lite/poll_bind_result are not part of the
 * published QQ Bot API docs. They back the portal's own scan-to-connect page
 * (q.qq.com/qqbot/openclaw/connect.html) and can change without notice. If this
 * flow breaks, fall back to registering an app by hand at https://q.qq.com and
 * running /qq:configure with the credentials.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PORTAL_HOST = process.env.QQ_PORTAL_HOST ?? 'q.qq.com'
const CREATE_PATH = '/lite/create_bind_task'
const POLL_PATH = '/lite/poll_bind_result'
const SOURCE = process.env.QQ_ONBOARD_SOURCE ?? 'claude-code'

const STATE_DIR = process.env.QQ_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'qq')
const ENV_FILE = join(STATE_DIR, '.env')
const ACCESS_FILE = join(STATE_DIR, 'access.json')

const POLL_INTERVAL_MS = 2000
const MAX_REFRESHES = 3

enum BindStatus {
  None = 0,
  Pending = 1,
  Completed = 2,
  Expired = 3,
}

/**
 * q.qq.com serves a JavaScript anti-bot challenge unless Accept is
 * application/json. Do not drop that header.
 */
function portalHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'claude-qq-channel/0.0.1',
  }
}

/** 256-bit AES key, base64. The portal encrypts the client secret to it. */
function generateBindKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
}

/** Ciphertext layout: IV(12) ‖ ciphertext ‖ tag(16), which is what AES-GCM expects. */
async function decryptSecret(encryptedBase64: string, keyBase64: string): Promise<string> {
  const raw = Buffer.from(encryptedBase64, 'base64')
  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.from(keyBase64, 'base64'),
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  )
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: raw.subarray(0, 12) },
    key,
    raw.subarray(12),
  )
  return new TextDecoder().decode(plain)
}

async function portalPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`https://${PORTAL_HOST}${path}`, {
    method: 'POST',
    headers: portalHeaders(),
    body: JSON.stringify(body),
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
  const data = (await res.json()) as { retcode?: number; msg?: string; data?: any }
  if (data.retcode !== 0) throw new Error(data.msg ?? `${path} failed (retcode ${data.retcode})`)
  return data.data ?? {}
}

async function createBindTask(key: string): Promise<string> {
  const data = await portalPost(CREATE_PATH, { key })
  if (!data.task_id) throw new Error('create_bind_task: no task_id in response')
  return String(data.task_id)
}

type PollResult = {
  status: BindStatus
  appId: string
  encryptedSecret: string
  userOpenid: string
}

async function pollBindResult(taskId: string): Promise<PollResult> {
  const data = await portalPost(POLL_PATH, { task_id: taskId })
  return {
    status: (data.status ?? 0) as BindStatus,
    appId: String(data.bot_appid ?? ''),
    encryptedSecret: String(data.bot_encrypt_secret ?? ''),
    userOpenid: String(data.user_openid ?? ''),
  }
}

function connectUrl(taskId: string): string {
  return `https://q.qq.com/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskId)}&_wv=2&source=${SOURCE}`
}

/** Render a QR code with half-block characters so it scans from a terminal. */
async function renderQr(url: string): Promise<boolean> {
  let qrcode: any
  try {
    qrcode = await import('qrcode')
  } catch {
    return false
  }
  try {
    const out: string = await qrcode.toString(url, { type: 'terminal', small: true, errorCorrectionLevel: 'M' })
    process.stdout.write(`\n${out}\n`)
    return true
  } catch {
    return false
  }
}

function persist(appId: string, secret: string, openid: string): void {
  mkdirSync(STATE_DIR, { recursive: true })

  // .env — keep any unrelated keys the operator added by hand
  const existing = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split('\n') : []
  const kept = existing.filter(l => {
    const k = l.split('=')[0]?.trim()
    return l.trim() && k !== 'QQ_APP_ID' && k !== 'QQ_CLIENT_SECRET'
  })
  kept.push(`QQ_APP_ID=${appId}`, `QQ_CLIENT_SECRET=${secret}`)
  writeFileSync(ENV_FILE, `${kept.join('\n')}\n`, { mode: 0o600 })

  // access.json — the scanner is the operator, so allowlist them directly
  let access: any = { policy: 'allowlist', allowed: [], pending: {} }
  if (existsSync(ACCESS_FILE)) {
    try {
      access = { ...access, ...JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) }
    } catch {
      // corrupt file: start from the safe default rather than trusting it
    }
  }
  if (openid && !access.allowed.includes(openid)) access.allowed.push(openid)
  access.policy = 'allowlist'
  writeFileSync(ACCESS_FILE, JSON.stringify(access, null, 2), { mode: 0o600 })
}

export async function qrRegister(timeoutSeconds = 600): Promise<{
  appId: string
  userOpenid: string
} | null> {
  const deadline = Date.now() + timeoutSeconds * 1000

  for (let refresh = 0; refresh <= MAX_REFRESHES; refresh++) {
    const key = generateBindKey()
    const taskId = await createBindTask(key)
    const url = connectUrl(taskId)

    // A QR code is just a way to carry the URL to a phone. When there is no
    // terminal to look at (backgrounded, piped, driven remotely), skip it and
    // let the caller hand the URL over however it likes.
    if (process.stdout.isTTY) await renderQr(url)
    process.stdout.write(`\nCONNECT_URL: ${url}\n\n  在手机上打开该链接，或用手机 QQ 扫描上方二维码。等待绑定...\n`)

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
      let result: PollResult
      try {
        result = await pollBindResult(taskId)
      } catch (err) {
        process.stderr.write(`  轮询失败，继续重试: ${err}\n`)
        continue
      }

      if (result.status === BindStatus.Completed) {
        const secret = await decryptSecret(result.encryptedSecret, key)
        persist(result.appId, secret, result.userOpenid)
        process.stdout.write(
          `\n  ✓ 配置完成\n` +
            `    App ID:  ${result.appId}\n` +
            `    你的 openid: ${result.userOpenid}（已加入白名单）\n` +
            `    凭据已写入 ${ENV_FILE}\n\n` +
            `  接下来重启 Claude Code：\n` +
            `    claude --dangerously-load-development-channels server:qq\n\n`,
        )
        return { appId: result.appId, userOpenid: result.userOpenid }
      }

      if (result.status === BindStatus.Expired) {
        process.stdout.write(`\n  二维码已过期，正在刷新... (${refresh + 1}/${MAX_REFRESHES})\n`)
        break
      }
    }

    if (Date.now() >= deadline) break
  }

  process.stderr.write('\n  超时或二维码反复过期，未完成配置。\n')
  return null
}

if (import.meta.main) {
  const ok = await qrRegister()
  process.exit(ok ? 0 : 1)
}
