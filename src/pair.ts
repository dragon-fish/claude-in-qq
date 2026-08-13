#!/usr/bin/env bun
/**
 * Allowlist management, run on the machine itself.
 *
 * Approving a pairing code has to happen here rather than over QQ: whoever is
 * on the allowlist can also approve tool calls, so letting a chat message grant
 * that would make the allowlist self-serving. A stranger messaging the bot only
 * ever receives a code — turning it into access takes someone at the keyboard.
 *
 *   bun run pair              list the allowlist and any pending codes
 *   bun run pair <code>       approve a pending code
 *   bun run pair remove <id>  revoke an openid
 */

import { dropExpiredPending, loadAccess, saveAccess } from './qq.ts'

const [, , ...args] = process.argv
const cmd = (args[0] ?? '').trim()

const access = loadAccess()
dropExpiredPending(access)

function list(): void {
  console.log(`策略: ${access.policy}`)
  console.log(`白名单 (${access.allowed.length}):`)
  for (const id of access.allowed) console.log(`  ${id}`)

  const pending = Object.entries(access.pending)
  console.log(`待配对 (${pending.length}):`)
  for (const [code, entry] of pending) {
    const mins = Math.max(0, Math.round((entry.expires_at - Date.now()) / 60000))
    console.log(`  ${code}  ->  ${entry.openid}  (${mins} 分钟后过期)`)
  }
  if (pending.length) console.log(`\n批准: bun run pair <code>`)
}

if (!cmd) {
  list()
  process.exit(0)
}

if (cmd === 'remove') {
  const target = (args[1] ?? '').trim()
  if (!target) {
    console.error('用法: bun run pair remove <openid>')
    process.exit(1)
  }
  const before = access.allowed.length
  access.allowed = access.allowed.filter(id => id !== target)
  if (access.allowed.length === before) {
    console.error(`不在白名单里: ${target}`)
    process.exit(1)
  }
  saveAccess(access)
  console.log(`已移除 ${target}`)
  process.exit(0)
}

const entry = access.pending[cmd]
if (!entry) {
  console.error(`没有这个配对码（或已过期）: ${cmd}`)
  console.error('对方需要重新给 bot 发一条消息以获取新码。')
  process.exit(1)
}

if (!access.allowed.includes(entry.openid)) access.allowed.push(entry.openid)
delete access.pending[cmd]
saveAccess(access)

console.log(`已授权 ${entry.openid}`)
console.log('注意：白名单成员同时拥有批准工具调用的权限。')
