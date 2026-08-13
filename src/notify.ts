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
 *
 * Every message is labelled with its origin, because the operator is already
 * chatting with the bridge in that same QQ window and an unattributed line
 * would read as something the bridge's Claude said.
 *
 * These are active messages against a 1000/day account quota, so they are for
 * things worth interrupting someone over, not progress chatter.
 */

import { homedir } from 'node:os'
import { basename } from 'node:path'
import { appendRelayed, HAS_CREDENTIALS, loadAccess, sendToQQ } from './qq.js'

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

let text = words.join(' ').trim()
if (!text && !process.stdin.isTTY) text = (await readStdin()).trim()

if (!text) {
  console.error('用法: bun run notify [--from <来源>] <消息>')
  console.error('      <消息> 也可以从 stdin 传入')
  process.exit(1)
}

if (!HAS_CREDENTIALS) {
  console.error('QQ 凭据缺失，先跑: bun run onboard')
  process.exit(1)
}

const access = loadAccess()
if (!access.allowed.length) {
  console.error('白名单为空，没有可送达的人。给 bot 发条消息拿配对码，再跑 bun run pair <code>')
  process.exit(1)
}

const cwd = process.cwd().replace(homedir(), '~')
const origin = from || basename(process.cwd())
const body = from
  ? `**${from}**（\`${cwd}\`）下的 Claude 给你留言：\n\n${text}`
  : `\`${cwd}\` 下的 Claude 给你留言：\n\n${text}`

let failed = 0
for (const openid of access.allowed) {
  try {
    await sendToQQ(openid, body)
  } catch (err) {
    failed++
    console.error(`发送给 ${openid.slice(0, 8)} 失败:`, err instanceof Error ? err.message : err)
  }
}

if (failed === access.allowed.length) process.exit(1)

// Tell the bridge's agent what went out on its channel. Without this the
// operator can reply "about that thing just now" to an agent that never saw it.
appendRelayed({ at: Date.now(), from: origin, cwd, text })

console.log(`已送达 ${access.allowed.length - failed}/${access.allowed.length}`)
