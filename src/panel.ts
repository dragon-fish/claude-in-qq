#!/usr/bin/env bun
/**
 * Publish the slash commands to QQ's command panel — the list that appears when
 * the operator taps "/" in the chat input.
 *
 * The bridge syncs both panels — private and group — at startup, updating its
 * own panel in place; this does the same without a restart, and lists or
 * deletes panels. Panels are per-application and capped at 20.
 *
 *   bun run panel           publish the current commands
 *   bun run panel list      show existing panels
 *   bun run panel delete <panel_id>
 */

import { panelEntries } from './commands.js'
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

for (const scope of ['c2c', 'group'] as const) {
  const entries = panelEntries(scope)
  const panelId = await syncCommandPanel(entries, scope)
  console.log(`已同步 ${entries.length} 条指令 → ${scope} ${panelId}`)
  for (const e of entries) console.log(`  ${e.name}  ${e.desc}`)
}
