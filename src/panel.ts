#!/usr/bin/env bun
/**
 * Publish the slash commands to QQ's command panel — the list that appears when
 * the operator taps "/" in the chat input.
 *
 * Run it after adding or renaming a command. Not done at startup: panels are
 * per-application and capped at 20, and a sync is a write QQ does not need on
 * every restart of a bridge whose command list changes about never.
 *
 *   bun run panel           publish the current commands
 *   bun run panel list      show existing panels
 *   bun run panel delete <panel_id>
 */

import './commands.js' // registers the commands as a side effect
import { allCommands } from './commands.js'
import { deleteCommandPanel, HAS_CREDENTIALS, listCommandPanels, syncCommandPanel } from './qq.js'

if (!HAS_CREDENTIALS) {
  console.error('QQ 凭据缺失，先跑: bun run onboard')
  process.exit(1)
}

const [, , cmd, arg] = process.argv

if (cmd === 'list') {
  const panels = await listCommandPanels()
  if (!panels.length) console.log('还没有指令面板')
  for (const p of panels) {
    console.log(`${p.panel_id}  ${p.items} 项  ${p.remark ?? '(无备注)'}`)
  }
  process.exit(0)
}

if (cmd === 'delete') {
  if (!arg) {
    console.error('用法: bun run panel delete <panel_id>')
    process.exit(1)
  }
  await deleteCommandPanel(arg)
  console.log(`已删除 ${arg}`)
  process.exit(0)
}

const entries = allCommands().map(c => ({ name: `/${c.name}`, desc: c.summary }))
const panelId = await syncCommandPanel(entries)

console.log(`已同步 ${entries.length} 条指令 → ${panelId}`)
for (const e of entries) console.log(`  ${e.name}  ${e.desc}`)
