/**
 * Slash commands.
 *
 * Claude Code's own slash commands are parsed by its CLI before a prompt ever
 * reaches the model, so they cannot arrive over a chat transport. These are
 * reimplemented on top of the SDK's session-control methods.
 *
 * Commands never touch bridge state directly — everything they need arrives as
 * `CommandDeps`, so this file stays testable and the bridge keeps ownership of
 * the session lifecycle.
 */

import { listSessions } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** How much meaning the buttons carry on their own; see buildAskKeyboard. */
export type AskMode = 'text' | 'truncated' | 'letters'

export type CommandDeps = {
  /** Send a message to the operator. */
  reply(text: string): Promise<void>
  /**
   * Present options as buttons and wait. Returns the chosen index, or -1 when
   * the operator answered with something that matched no option.
   *
   * `renderBody` is called with whether the buttons degraded to letters, so a
   * caller can add a table only when the buttons no longer carry the meaning.
   */
  askChoice(options: string[], renderBody: (mode: AskMode) => string): Promise<number>
  /** The live query, or null before the first message starts a session. */
  query(): any | null
  workdir(): string
  setWorkdir(path: string): void
  /** Tear the session down; the main loop rebuilds it. */
  restartSession(reason: string): void
  sessionId(): string | null
  setSessionId(id: string | null): void
  /**
   * Tell the agent something it cannot observe. Delivered with the next real
   * message, since commands happen entirely outside its view.
   */
  noteToAgent(text: string): void
  /** Record that a command ran, so the agent learns what happened while it was blind. */
  recordCommand(name: string, args: string): void
  permissionMode(): string
  setPermissionMode(mode: string): void
  /** Which parts of the work are shown alongside the answer. */
  verbose(): { thinking: boolean; tools: boolean }
  setVerbose(v: { thinking: boolean; tools: boolean }): void
  counts(): { allowed: number; approvals: number; questions: number }
}

export type Command = {
  name: string
  usage: string
  summary: string
  run(arg: string, deps: CommandDeps): Promise<void>
}

const registry = new Map<string, Command>()

export function register(...commands: Command[]): void {
  for (const c of commands) registry.set(c.name, c)
}

/** Registration order, which is the order /help and the QQ command panel show. */
export function allCommands(): Command[] {
  return [...registry.values()]
}

/** Format a number with thousands separators. */
const n = (v: number) => v.toLocaleString('en-US')

/** Escape a table cell: a literal pipe would break the row. */
const cell = (s: string, max = 40) => String(s ?? '').replace(/\|/g, '｜').slice(0, max)

async function requireQuery(deps: CommandDeps): Promise<any | null> {
  const q = deps.query()
  if (!q) await deps.reply('会话尚未启动，先发一条消息。')
  return q
}

// ----------------------------------------------------------------- formatting

/**
 * Render context usage the way /context does in a terminal: headline numbers,
 * then where the tokens went. The raw response also carries grid geometry for
 * drawing squares, which does not survive being read on a phone.
 */
export function formatContextUsage(u: any): string {
  const pct = typeof u.percentage === 'number' ? u.percentage.toFixed(1) : '?'
  const lines = [
    '**上下文占用**',
    `模型：\`${u.model ?? '?'}\``,
    `已用：${n(u.totalTokens ?? 0)} / ${n(u.maxTokens ?? 0)}　(${pct}%)`,
  ]
  const cats = (u.categories ?? [])
    .filter((c: any) => c.tokens > 0)
    .sort((a: any, b: any) => b.tokens - a.tokens)
  if (cats.length) {
    lines.push('', '| 类别 | tokens |', '| --- | --- |')
    for (const c of cats) lines.push(`| ${cell(c.name)} | ${n(c.tokens)} |`)
  }
  return lines.join('\n')
}

/**
 * How long until a window resets, in words.
 *
 * The API gives an ISO timestamp, which answers "when" — but the question
 * being asked is "how long do I have to wait", and on a phone at 1am nobody
 * wants to subtract two timestamps in their head.
 */
function untilReset(iso: string | null | undefined): string {
  if (!iso) return '—'
  const ms = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(ms)) return '—'
  if (ms <= 0) return '已重置'
  const minutes = Math.floor(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    return hours % 24 ? `${days} 天 ${hours % 24} 小时后` : `${days} 天后`
  }
  if (hours > 0) return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分后` : `${hours} 小时后`
  return `${Math.max(minutes, 1)} 分后`
}

const USAGE_WINDOWS: [string, string][] = [
  ['five_hour', '5 小时'],
  ['seven_day', '7 天'],
  ['seven_day_opus', '7 天 · Opus'],
  ['seven_day_sonnet', '7 天 · Sonnet'],
  ['seven_day_oauth_apps', '7 天 · OAuth 应用'],
]

/** Render the plan windows. Exported so the shape stays testable. */
export function formatUsage(u: any): string {
  const lines = ['**用量**']
  if (u.subscription_type) lines.push(`套餐：\`${u.subscription_type}\``)

  if (u.rate_limits_available === false || !u.rate_limits) {
    // API key, Bedrock, Vertex, or a token without the usage scope — the plan
    // windows are a claude.ai concept and simply do not exist here.
    lines.push('', '当前登录方式没有套餐额度（API key 或第三方后端）。')
  } else {
    const rows = USAGE_WINDOWS.flatMap(([key, label]) => {
      const w = u.rate_limits[key]
      if (!w) return []
      const used = typeof w.utilization === 'number' ? `${w.utilization.toFixed(0)}%` : '—'
      return [`| ${label} | ${used} | ${untilReset(w.resets_at)} |`]
    })
    if (rows.length) lines.push('', '| 窗口 | 已用 | 重置 |', '| --- | --- | --- |', ...rows)
    else lines.push('', '暂无额度数据。')
  }

  const cost = u.session?.total_cost_usd
  if (typeof cost === 'number' && cost > 0) lines.push('', `本次会话：$${cost.toFixed(2)}`)
  return lines.join('\n')
}

// ------------------------------------------------------------------- commands

register(
  {
    name: 'help',
    usage: '/help',
    summary: '显示本条',
    async run(_arg, deps) {
      const lines = ['**可用指令**']
      for (const c of registry.values()) lines.push(`\`${c.usage}\` ${c.summary}`)
      lines.push('', '其余消息都直接发给 Claude。')
      await deps.reply(lines.join('\n'))
    },
  },

  {
    name: 'stop',
    usage: '/stop',
    summary: '打断当前任务',
    async run(_arg, deps) {
      const q = await requireQuery(deps)
      if (!q) return
      await q.interrupt()
      deps.noteToAgent(
        '操作者打断了你上一个任务，它没有完成。不要假设之前的步骤已经生效；' +
          '如果需要，先确认当前状态再继续。',
      )
      await deps.reply('⛔ 已打断。')
    },
  },

  {
    name: 'clear',
    usage: '/clear',
    summary: '清空上下文，开始新会话',
    async run(_arg, deps) {
      deps.setSessionId(null)
      deps.restartSession('clear')
      await deps.reply('🧹 已清空上下文，下一条消息开始新会话。')
    },
  },

  {
    name: 'context',
    usage: '/context',
    summary: '查看上下文占用',
    async run(_arg, deps) {
      const q = await requireQuery(deps)
      if (!q) return
      try {
        await deps.reply(formatContextUsage(await q.getContextUsage()))
      } catch (err) {
        await deps.reply(`查询失败：${err}`)
      }
    },
  },

  {
    name: 'model',
    usage: '/model [名字|default]',
    summary: '不带参数则列出可选模型',
    async run(arg, deps) {
      const q = await requireQuery(deps)
      if (!q) return

      if (arg && arg.toLowerCase() !== 'default') {
        try {
          await q.setModel(arg)
          await deps.reply(`已切换到 \`${arg}\``)
        } catch (err) {
          await deps.reply(`切换失败：${err}`)
        }
        return
      }
      if (arg) {
        // Only an explicit "default" resets. A bare /model listing beats a bare
        // /model silently changing the model out from under the operator.
        try {
          await q.setModel(undefined)
          await deps.reply('已恢复默认模型')
        } catch (err) {
          await deps.reply(`恢复失败：${err}`)
        }
        return
      }

      let models: any[]
      try {
        models = await q.supportedModels()
      } catch (err) {
        await deps.reply(`读取模型列表失败：${err}`)
        return
      }
      if (!models?.length) {
        await deps.reply('没有拿到可用模型列表。')
        return
      }

      const labels = models.map(m => m.displayName || m.value)
      const idx = await deps.askChoice(labels, mode => {
        const lines = ['**可用模型**', '']
        // The table only earns its place when the buttons stop being readable.
        if (mode !== 'text') {
          const label = mode === 'letters' ? (i: number) => 'ABCDEFGH'[i] : (i: number) => labels[i]
          lines.push('| | 模型 | 说明 |', '| --- | --- | --- |')
          models.forEach((m, i) => lines.push(`| ${label(i)} | ${cell(labels[i], 20)} | ${cell(m.description)} |`))
          lines.push('')
        }
        lines.push('点按钮切换，或 `/model default` 恢复默认')
        return lines.join('\n')
      })
      if (idx < 0) return

      const target = models[idx].value
      try {
        await q.setModel(target)
        await deps.reply(`已切换到 \`${target}\``)
      } catch (err) {
        await deps.reply(`切换失败：${err}`)
      }
    },
  },

  {
    name: 'mode',
    usage: '/mode [模式]',
    summary: '不带参数则列出权限模式',
    async run(arg, deps) {
      const q = await requireQuery(deps)
      if (!q) return

      // bypassPermissions is deliberately absent: it needs
      // allowDangerouslySkipPermissions, and a phone is not an isolated VM.
      const modes = [
        { value: 'auto', label: 'auto 智能判断', desc: '分类器放行常规操作，只对有风险的问你' },
        { value: 'default', label: 'default 每步都问', desc: '任何写入和命令都要批准' },
        { value: 'acceptEdits', label: 'acceptEdits 改文件免批', desc: '文件编辑自动通过，命令仍要批' },
        { value: 'plan', label: 'plan 只读规划', desc: '只看不动，先给方案' },
      ]

      const apply = async (value: string) => {
        try {
          await q.setPermissionMode(value)
          deps.setPermissionMode(value)
          deps.noteToAgent(`权限模式已切换为 ${value}，工具调用被批准或拦截的方式随之改变。`)
          await deps.reply(`权限模式已切到 \`${value}\``)
        } catch (err) {
          await deps.reply(`切换失败：${err}`)
        }
      }

      if (arg) {
        const hit = modes.find(m => m.value.toLowerCase() === arg.toLowerCase())
        if (!hit) {
          await deps.reply(`未知模式 \`${arg}\`，可选：${modes.map(m => m.value).join('、')}`)
          return
        }
        await apply(hit.value)
        return
      }

      const labels = modes.map(m => m.label)
      const idx = await deps.askChoice(labels, mode => {
        const lines = [`**权限模式**（当前 \`${deps.permissionMode()}\`）`, '']
        if (mode !== 'text') {
          lines.push('| | 模式 | 说明 |', '| --- | --- | --- |')
          modes.forEach((m, i) =>
            lines.push(`| ${mode === 'letters' ? 'ABCDEFGH'[i] : '·'} | ${m.value} | ${cell(m.desc)} |`),
          )
          lines.push('')
        }
        lines.push('点按钮切换')
        return lines.join('\n')
      })
      if (idx < 0) return
      await apply(modes[idx].value)
    },
  },

  {
    name: 'verbose',
    usage: '/verbose [full|think|tools|off]',
    summary: '回复里是否附带思考与工具调用',
    async run(arg, deps) {
      // Both on by default: a long task that shows nothing reads as a hang.
      // The trace rides inside the same streamed message as the answer, in a
      // code block QQ folds past fifteen lines, so it costs no extra message —
      // only screen. This is the switch for when that screen is the problem.
      const levels = [
        { value: 'full', label: 'full 思考+工具', thinking: true, tools: true },
        { value: 'think', label: 'think 只要思考', thinking: true, tools: false },
        { value: 'tools', label: 'tools 只要工具', thinking: false, tools: true },
        { value: 'off', label: 'off 只要答案', thinking: false, tools: false },
      ]
      const current = deps.verbose()
      const name = (v: { thinking: boolean; tools: boolean }) =>
        levels.find(l => l.thinking === v.thinking && l.tools === v.tools)?.value ?? '?'

      const apply = async (hit: (typeof levels)[number]) => {
        deps.setVerbose({ thinking: hit.thinking, tools: hit.tools })
        await deps.reply(`已切到 \`${hit.value}\``)
      }

      if (arg) {
        const hit = levels.find(l => l.value.toLowerCase() === arg.toLowerCase())
        if (!hit) {
          await deps.reply(`未知取值 \`${arg}\`，可选：${levels.map(l => l.value).join('、')}`)
          return
        }
        await apply(hit)
        return
      }

      const idx = await deps.askChoice(
        levels.map(l => l.label),
        mode => {
          const lines = [`**回复详略**（当前 \`${name(current)}\`）`, '']
          if (mode !== 'text') {
            lines.push('| | 取值 | 显示 |', '| --- | --- | --- |')
            levels.forEach((l, i) =>
              lines.push(
                `| ${mode === 'letters' ? 'ABCDEFGH'[i] : '·'} | ${l.value} | ${cell(
                  [l.thinking && '思考', l.tools && '工具调用'].filter(Boolean).join(' + ') || '只有答案',
                )} |`,
              ),
            )
            lines.push('')
          }
          lines.push('点按钮切换')
          return lines.join('\n')
        },
      )
      if (idx < 0) return
      await apply(levels[idx])
    },
  },

  {
    name: 'usage',
    usage: '/usage',
    summary: '套餐额度：5 小时 / 7 天窗口用了多少，何时重置',
    async run(_arg, deps) {
      const q = await requireQuery(deps)
      if (!q) return

      // The SDK spells this one with a warning in the name. Honour it: call it
      // through an optional chain and catch, so the day it is renamed this
      // command degrades to a sentence instead of taking the turn down.
      const read = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
      if (typeof read !== 'function') {
        await deps.reply('这个 SDK 版本没有暴露用量接口。')
        return
      }
      try {
        await deps.reply(formatUsage(await read.call(q)))
      } catch (err) {
        await deps.reply(`读取用量失败：${err}`)
      }
    },
  },

  {
    name: 'resume',
    usage: '/resume',
    summary: '从历史会话里挑一个恢复',
    async run(_arg, deps) {
      const dir = deps.workdir()
      let sessions: any[]
      try {
        // Sessions are per project directory, so this lists what exists under
        // the current workdir rather than everything on the machine.
        sessions = await listSessions({ dir, limit: 6 })
      } catch (err) {
        await deps.reply(`读取历史会话失败：${err}`)
        return
      }
      if (!sessions.length) {
        await deps.reply(`\`${dir}\` 下还没有历史会话。`)
        return
      }

      const when = (s: any) =>
        new Date(s.lastModified).toLocaleString('zh-CN', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      const title = (s: any) => cell(s.customTitle ?? s.summary ?? '(无标题)')
      const labels = sessions.map(s => `${when(s)} ${title(s)}`.slice(0, 60))

      const idx = await deps.askChoice(labels, mode => {
        // When the labels fit on the buttons, a table would just repeat them.
        const lines = ['**最近的会话**', '']
        if (mode !== 'text') {
          lines.push('| | 时间 | 摘要 |', '| --- | --- | --- |')
          sessions.forEach((s, i) =>
            lines.push(`| ${mode === 'letters' ? 'ABCDEFGH'[i] : '·'} | ${when(s)} | ${title(s)} |`),
          )
          lines.push('')
        }
        lines.push('点按钮恢复到那个会话')
        return lines.join('\n')
      })
      if (idx < 0) return

      deps.setSessionId(sessions[idx].sessionId)
      deps.restartSession('resume')
      deps.noteToAgent('操作者从历史记录中恢复了这个会话，中间可能隔了很久。')
      await deps.reply('已切到该会话，下一条消息接着聊。')
    },
  },

  {
    name: 'cwd',
    usage: '/cwd [路径]',
    summary: '查看或切换工作目录（保留上下文）',
    async run(arg, deps) {
      if (!arg) {
        await deps.reply(`当前工作目录：\`${deps.workdir()}\``)
        return
      }
      const next = arg.startsWith('~') ? join(homedir(), arg.slice(1)) : arg
      if (!existsSync(next)) {
        await deps.reply(`目录不存在：\`${next}\``)
        return
      }
      // The query is rebuilt because cwd is fixed at creation, but the session
      // is kept: moving to another directory is not a reason to forget the
      // conversation that sent you there. /clear is how you ask for that.
      deps.setWorkdir(next)
      deps.restartSession('cwd')
      deps.noteToAgent(`工作目录已切换为 ${next}。对话继续，但之前提到的相对路径要按新目录重新理解。`)
      await deps.reply(`📁 已切换到 \`${next}\`（上下文保留）`)
    },
  },

  {
    name: 'status',
    usage: '/status',
    summary: '查看桥接状态',
    async run(_arg, deps) {
      const c = deps.counts()
      await deps.reply(
        [
          '**桥接状态**',
          `工作目录：\`${deps.workdir()}\``,
          `会话：\`${deps.sessionId() ?? '(新会话)'}\``,
          `权限模式：\`${deps.permissionMode()}\``,
          `白名单：${c.allowed} 人`,
          `待审批：${c.approvals}　待回答：${c.questions}`,
        ].join('\n'),
      )
    },
  },
)

/**
 * Run `text` as a command. Returns false when it is not one, so the caller can
 * pass it through to the agent.
 */
export async function dispatch(text: string, deps: CommandDeps): Promise<boolean> {
  const m = /^\s*\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text)
  if (!m) return false
  const cmd = registry.get(m[1].toLowerCase())
  if (!cmd) return false

  const arg = (m[2] ?? '').trim()
  // Recorded before running: a command that throws still happened, and the
  // agent is better off knowing it was attempted.
  deps.recordCommand(cmd.name, arg)

  try {
    await cmd.run(arg, deps)
  } catch (err) {
    await deps.reply(`\`/${cmd.name}\` 执行出错：${err}`)
  }
  return true
}
