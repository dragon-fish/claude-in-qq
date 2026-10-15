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
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nativePath } from './paths.js'

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
  /** How much of the work is shown alongside the answer. */
  verbose(): 'full' | 'balanced' | 'off'
  setVerbose(level: 'full' | 'balanced' | 'off'): void
  counts(): { allowed: number; approvals: number; questions: number }
  /** What brings the process back after it exits, or null when nothing does. */
  supervisor(): 'launchd' | 'schtasks' | null
  /**
   * Exit through the normal shutdown path; the supervisor starts a fresh process.
   * `remark` is appended to the wake note, so the next process hands it to the agent.
   */
  restartProcess(remark: string): void
  /** Whether whoever sent this command is the owner. */
  senderIsOwner(): boolean
  /** Which kind of chat the command was sent in. */
  where(): CommandScope
  /**
   * The group's shown name and where it came from: the owner's override, the
   * name QQ reports, or the openid's head when neither exists. Null in private chat.
   */
  groupName(): { name: string; source: 'owner' | 'qq' | 'openid' } | null
  /** Set the owner's override for the group's name, or clear it with null. */
  setGroupName(name: string | null): void
  /** Whether the owner declared this group to hold only the owner and the owner's bots. */
  trusted(): boolean
  setTrusted(on: boolean): void
  /**
   * QQ's group info and this bot's state in the group, each the parsed
   * response or, when the lookup failed, why.
   */
  groupInfo(): Promise<{ info: Record<string, any> | string; bot: Record<string, any> | string }>
  /** A member's display name: from the message's own mentions, then from group history. */
  nameOf(openid: string): string | null
  listOps(): { openid: string; remark: string }[]
  listNicknames(): string[]
  addNickname(nickname: string): 'added' | 'exists'
  removeNickname(nickname: string): 'removed' | 'absent'
  addOp(openid: string, remark: string): 'added' | 'updated' | 'owner'
  removeOp(openid: string): 'removed' | 'owner' | 'absent'
}

/** A chat kind, and also the only one a command may be limited to. */
export type CommandScope = 'private' | 'group'

export type Command = {
  name: string
  /**
   * The only kind of chat this command runs in; both when absent. Process-level
   * commands are `private`: a group conversation is one of several sharing the
   * process, and restarting or re-pointing the process is the owner's call to
   * make where only the owner reads.
   */
  scope?: CommandScope
  /**
   * Extra names that reach this command when typed. Deliberately kept out of
   * the QQ command panel: that panel is capped at 20 entries, and an alias is
   * a shortcut for fingers, not a second row to scroll past.
   */
  aliases?: string[]
  usage: string
  summary: string
  run(arg: string, deps: CommandDeps): Promise<void>
}

const registry = new Map<string, Command>()
/** Alias → command. Held apart from `registry` so a real name always wins. */
const aliasMap = new Map<string, Command>()

export function register(...commands: Command[]): void {
  for (const c of commands) {
    registry.set(c.name, c)
    // First claim on a word keeps it. Two commands wanting the same alias is a
    // mistake in the table below, not something to settle by registration order.
    for (const a of c.aliases ?? []) if (!aliasMap.has(a)) aliasMap.set(a, c)
  }
}

/** Registration order, which is the order /help and the QQ command panel show. */
export function allCommands(): Command[] {
  return [...registry.values()]
}

const usableIn = (c: Command, where: CommandScope) => !c.scope || c.scope === where

/**
 * The command panel for one QQ scope. The group panel lists only what runs in
 * a group; the private one lists everything, group-only commands included,
 * since the owner reads it to learn what exists.
 */
export function panelEntries(scope: 'c2c' | 'group'): { name: string; desc: string }[] {
  return allCommands()
    .filter(c => scope === 'c2c' || usableIn(c, 'group'))
    .map(c => ({ name: `/${c.name}`, desc: c.summary }))
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

// -------------------------------------------------------------------- version

/** Where this process's own code lives — not workdir, which /cwd moves. */
const SRC_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * Read once, at load. This describes the code the running process was started
 * from, which is the whole point: reading it per call would report whatever is
 * on disk now, and "did the restart actually pick up my edit" is exactly the
 * question this command exists to answer.
 */
const BUILD = (() => {
  const repo = join(SRC_DIR, '..')
  const git = (...args: string[]) => {
    try {
      // stderr is dropped: outside a repo git is loud, and a missing version
      // string is not worth a stack trace in the log at every boot.
      return execFileSync('git', ['-C', repo, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      return ''
    }
  }
  return {
    commit: git('rev-parse', '--short', 'HEAD'),
    head: git('rev-parse', 'HEAD'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    date: git('log', '-1', '--format=%cd', '--date=format:%Y-%m-%d %H:%M'),
    dirty: git('status', '--porcelain') !== '',
  }
})()

/** Full hash of the commit this process started on, or '' outside a repo. */
export const buildHead = () => BUILD.head

/** The SDK actually installed, which is not necessarily the range in package.json. */
const SDK_VERSION = (() => {
  try {
    const p = join(SRC_DIR, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json')
    return JSON.parse(readFileSync(p, 'utf8')).version as string
  } catch {
    return ''
  }
})()

/** How long this process has been up, in words. */
function uptimeWords(): string {
  const s = Math.floor(process.uptime())
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d} 天 ${h % 24} 小时` : `${d} 天`
}

// ------------------------------------------------------------------- commands

register(
  {
    name: 'help',
    aliases: ['h'],
    usage: '/help',
    summary: '显示本条',
    async run(_arg, deps) {
      const lines = ['**可用指令**']
      for (const c of registry.values()) {
        if (!usableIn(c, deps.where())) continue
        // The command panel lists real names only, so this is where an alias
        // becomes findable at all. Bulleted because a long entry wraps on a
        // phone, and without the bullet the tail of one command reads as the
        // start of the next.
        const alt = c.aliases?.length ? ` (${c.aliases.map(a => `\`/${a}\``).join(', ')})` : ''
        lines.push(`- \`${c.usage}\`${alt} — ${c.summary}`)
      }
      lines.push('', '其余消息都直接发给 Claude。')
      await deps.reply(lines.join('\n'))
    },
  },

  {
    name: 'stop',
    aliases: ['cancel'],
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
    aliases: ['cl', 'new'],
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
    aliases: ['ctx'],
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
    aliases: ['models'],
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

      // supportedModels() says what is available, never what is in use. The
      // live id only surfaces on context usage, so it costs a second call.
      let live: string | null = null
      try {
        live = (await q.getContextUsage())?.model ?? null
      } catch {
        // Not worth failing the listing over; the header just omits it.
      }
      // Context usage reports a canonical id while the rows carry suffixed
      // ones — 'claude-opus-5' against 'claude-opus-5[1m]' — so the bracketed
      // tail comes off before comparing, or nothing ever matches.
      const bare = (s: string | undefined) => s?.replace(/\[[^\]]*\]$/, '')
      const wanted = bare(live ?? undefined)
      // Several rows can resolve to one model: 'default' and 'opus' both land on
      // Opus 5.5. Only the first is marked — they name the same thing, and two
      // markers would pose a question that has no answer.
      const liveIndex = wanted
        ? models.findIndex(m => bare(m.value) === wanted || bare(m.resolvedModel) === wanted)
        : -1

      const labels = models.map(m => m.displayName || m.value)
      const idx = await deps.askChoice(labels, mode => {
        const lines = ['**可用模型**']
        // A button carries the name and nothing else, and the alias rows hide
        // the thing most worth knowing — 'Default (recommended)' never says
        // which version it resolves to today. So the list below the buttons
        // carries the descriptions, which is also where the version lives for
        // those rows. Numbered, so a truncated button still has a referent.
        if (liveIndex < 0 && live) lines.push(`当前：\`${live}\``)
        lines.push('')
        models.forEach((m, i) => {
          const marker = mode === 'letters' ? ('ABCDEFGH'[i] ?? String(i + 1)) : `${i + 1}.`
          const desc = m.description ? ` · ${cell(m.description, 60)}` : ''
          lines.push(`${marker} **${m.displayName || m.value}**${desc}${i === liveIndex ? ' ←当前' : ''}`)
        })
        lines.push('')
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
    aliases: ['perm'],
    usage: '/mode [模式]',
    summary: '不带参数则列出权限模式',
    async run(arg, deps) {
      const q = await requireQuery(deps)
      if (!q) return

      const modes = [
        { value: 'auto', label: 'auto 智能判断', desc: '分类器放行常规操作，只对有风险的问你' },
        { value: 'default', label: 'default 每步都问', desc: '任何写入和命令都要批准' },
        { value: 'acceptEdits', label: 'acceptEdits 改文件免批', desc: '文件编辑自动通过，命令仍要批' },
        { value: 'plan', label: 'plan 只读规划', desc: '只看不动，先给方案' },
      ]
      // Private chat only, never a group: there non-owner ops start turns, and
      // in this mode their requests would run with no approval card to stop
      // them. Group sessions refuse the switch anyway (no allowDangerouslySkipPermissions).
      if (deps.where() === 'private') {
        modes.push({ value: 'bypassPermissions', label: 'bypass 危险全开', desc: '所有工具调用不经审批直接执行' })
      }

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
    aliases: ['vb'],
    usage: '/verbose [full|balanced|off]',
    summary: '回复里附带多少过程',
    async run(arg, deps) {
      // The trace rides inside the same streamed message as the answer, in a
      // code block QQ folds past fifteen lines, so it costs no extra message —
      // only screen. This is the switch for when that screen is the problem.
      const levels = [
        { value: 'full', label: 'full 完整过程', desc: '思考全文、每次调用的参数、命令输出' },
        { value: 'balanced', label: 'balanced 只报进度', desc: '思考中……／调用了哪些工具' },
        { value: 'off', label: 'off 只要答案', desc: '什么过程都不显示' },
      ] as const
      const current = deps.verbose()

      const apply = async (value: (typeof levels)[number]['value']) => {
        deps.setVerbose(value)
        await deps.reply(`已切到 \`${value}\``)
      }

      if (arg) {
        const hit = levels.find(l => l.value === arg.toLowerCase())
        if (!hit) {
          await deps.reply(`未知取值 \`${arg}\`，可选：${levels.map(l => l.value).join('、')}`)
          return
        }
        await apply(hit.value)
        return
      }

      const idx = await deps.askChoice(
        levels.map(l => l.label),
        mode => {
          const lines = [`**回复详略**（当前 \`${current}\`）`, '']
          if (mode !== 'text') {
            lines.push('| | 取值 | 显示 |', '| --- | --- | --- |')
            levels.forEach((l, i) =>
              lines.push(`| ${mode === 'letters' ? 'ABCDEFGH'[i] : '·'} | ${l.value} | ${cell(l.desc)} |`),
            )
            lines.push('')
          }
          lines.push('点按钮切换')
          return lines.join('\n')
        },
      )
      if (idx < 0) return
      await apply(levels[idx].value)
    },
  },

  {
    name: 'usage',
    aliases: ['quota'],
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
    aliases: ['r'],
    scope: 'private',
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
    aliases: ['cd'],
    usage: '/cwd [路径]',
    summary: '查看或切换工作目录（保留上下文）',
    async run(arg, deps) {
      if (!arg) {
        await deps.reply(`当前工作目录：\`${deps.workdir()}\``)
        return
      }
      const next = nativePath(arg, deps.workdir())
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
    aliases: ['st'],
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

  {
    name: 'restart',
    aliases: ['reload'],
    scope: 'private',
    usage: '/restart [附言]',
    summary: '立即重启 bridge 进程，加载新代码',
    async run(arg, deps) {
      const supervisor = deps.supervisor()
      if (!supervisor) return refuseUnsupervised(deps)
      await deps.reply(`🔄 正在重启，${SUPERVISOR_WORDS[supervisor]}。`)
      deps.restartProcess(arg)
    },
  },

  {
    name: 'op',
    usage: '/op add|remove|list [<@成员|id>] [备注]',
    summary: '管理群里能 @ 我开启对话的人',
    async run(arg, deps) {
      // Every slash command in a group is already owner-only, but private chat
      // under the `open` policy is not, and an op list anyone can edit is no list.
      if (!deps.senderIsOwner()) {
        await deps.reply('只有主人能管理 op 列表。')
        return
      }
      const [, rawSub = '', rest = ''] = /^(\S*)\s*([\s\S]*)$/.exec(arg) ?? []
      const sub = rawSub.toLowerCase() || 'list'

      if (sub === 'list' || sub === 'ls') {
        const ops = deps.listOps()
        const lines = ['**op 列表**（主人始终是 op，不在列表里）']
        if (ops.length) for (const o of ops) lines.push(`- ${o.remark} \`${o.openid}\``)
        else lines.push('', '（空）')
        await deps.reply(lines.join('\n'))
        return
      }

      // In a group the target is a mention, which QQ puts in the text as
      // <@member_openid>; in private chat it is the bare id.
      const target = /^<@!?([A-Za-z0-9]+)>\s*([\s\S]*)$/.exec(rest) ?? /^([A-Za-z0-9]{16,})\s*([\s\S]*)$/.exec(rest)
      if ((sub !== 'add' && sub !== 'remove' && sub !== 'rm') || !target) {
        await deps.reply('用法：`/op add <@成员|id> [备注]`、`/op remove <@成员|id>`、`/op list`')
        return
      }
      const [, id, tail] = target

      if (sub === 'add') {
        const remark = tail.trim() || deps.nameOf(id)
        if (!remark) {
          await deps.reply('这个 id 没见过，给一个备注名：`/op add <id> 备注`')
          return
        }
        const result = deps.addOp(id, remark)
        await deps.reply(
          result === 'owner'
            ? '主人本来就是 op，不用加。'
            : `${result === 'added' ? '已添加' : '已更新'} op：${remark}（\`${id}\`）`,
        )
        return
      }

      const result = deps.removeOp(id)
      await deps.reply(
        result === 'owner'
          ? '主人不能移出 op 列表。'
          : result === 'absent'
            ? `\`${id}\` 不在 op 列表里。`
            : `已移除 op \`${id}\``,
      )
    },
  },

  {
    name: 'group',
    scope: 'group',
    usage: '/group name [set [群名]] | trust [on|off] | info',
    summary: '这个群的名字和信息',
    async run(arg, deps) {
      const usage =
        '用法：`/group name` 查看群名，`/group name set <群名>` 自定义群名，' +
        '`/group name set` 清除自定义，`/group trust on|off` 标记这个群是否只有主人和主人自己的 bot，' +
        '`/group info` 查看群信息'
      const [, rawSub = '', rest = ''] = /^(\S*)\s*([\s\S]*)$/.exec(arg) ?? []
      const sub = rawSub.toLowerCase()

      if (sub === 'info') {
        await deps.reply(await groupInfoText(deps))
        return
      }
      if (sub === 'trust') {
        const value = rest.trim().toLowerCase()
        if (!value) {
          await deps.reply(`这个群${deps.trusted() ? '已' : '未'}标记为可信。${TRUST_MEANING}`)
          return
        }
        if (value !== 'on' && value !== 'off') {
          await deps.reply(usage)
          return
        }
        const on = value === 'on'
        deps.setTrusted(on)
        deps.noteToAgent(
          on
            ? '主人把这个群标记为可信：群里只有主人和主人自己的 bot。'
            : '主人取消了这个群的可信标记：群里可能有别人。',
        )
        await deps.reply(`${on ? '已把这个群标记为可信' : '已取消这个群的可信标记'}。${TRUST_MEANING}`)
        return
      }
      if (sub !== 'name') {
        await deps.reply(usage)
        return
      }

      const [, action = '', value = ''] = /^(\S*)\s*([\s\S]*)$/.exec(rest) ?? []
      if (!action) {
        const shown = deps.groupName()!
        await deps.reply(`这个群显示为「${shown.name}」（${NAME_SOURCE[shown.source]}）。`)
        return
      }
      if (action.toLowerCase() !== 'set') {
        await deps.reply(usage)
        return
      }
      // One line, and short: it is shown in the context of every turn and on
      // every card that comes from this group.
      const name = value.replace(/\s+/g, ' ').trim().slice(0, 30)
      deps.setGroupName(name || null)
      const shown = deps.groupName()!
      if (name) {
        deps.noteToAgent(`主人把这个群的显示名设为「${name}」。`)
        await deps.reply(`已把这个群的显示名设为「${name}」。`)
      } else {
        deps.noteToAgent(`主人清除了这个群的自定义名字，现在显示为「${shown.name}」。`)
        await deps.reply(`已清除自定义群名，现在显示为「${shown.name}」（${NAME_SOURCE[shown.source]}）。`)
      }
    },
  },

  {
    name: 'nick',
    usage: '/nick add|remove|list [昵称]',
    summary: '管理能代替 @ 叫我的昵称',
    async run(arg, deps) {
      if (!deps.senderIsOwner()) {
        await deps.reply('只有主人能管理昵称。')
        return
      }
      const [, rawSub = '', rest = ''] = /^(\S*)\s*([\s\S]*)$/.exec(arg) ?? []
      const sub = rawSub.toLowerCase() || 'list'
      const nickname = rest.trim()

      if (sub === 'list' || sub === 'ls') {
        const nicks = deps.listNicknames()
        await deps.reply(
          nicks.length
            ? `**昵称**（op 的群消息以昵称开头就等于 @ 我）\n${nicks.map(n => `- ${n}`).join('\n')}`
            : '还没有昵称，用 `/nick add <昵称>` 加一个。',
        )
        return
      }
      if ((sub !== 'add' && sub !== 'remove' && sub !== 'rm') || !nickname) {
        await deps.reply('用法：`/nick add <昵称>`、`/nick remove <昵称>`、`/nick list`')
        return
      }
      if (sub === 'add') {
        // A message opening with a slash is a command; a nickname that did
        // would turn the owner's commands into turns.
        if (nickname.startsWith('/')) {
          await deps.reply('昵称不能以 `/` 开头。')
          return
        }
        await deps.reply(deps.addNickname(nickname) === 'added' ? `已添加昵称「${nickname}」。` : `「${nickname}」已经是昵称了。`)
        return
      }
      await deps.reply(deps.removeNickname(nickname) === 'removed' ? `已移除昵称「${nickname}」。` : `「${nickname}」不是昵称。`)
    },
  },

  {
    name: 'version',
    aliases: ['v', 'ver'],
    usage: '/version',
    summary: '当前跑的是哪个版本',
    async run(_arg, deps) {
      const lines = ['**版本**']
      if (BUILD.commit) {
        const dirty = BUILD.dirty ? '（启动时有未提交改动）' : ''
        lines.push(`提交：\`${BUILD.commit}\`${dirty}`)
        if (BUILD.branch) lines.push(`分支：\`${BUILD.branch}\``)
        if (BUILD.date) lines.push(`提交于：${BUILD.date}`)
      } else {
        lines.push('拿不到 git 信息：不在仓库里，或者 git 不可用。')
      }
      if (SDK_VERSION) lines.push(`Agent SDK：\`${SDK_VERSION}\``)
      lines.push(`已运行：${uptimeWords()}`)
      await deps.reply(lines.join('\n'))
    },
  },
)

// ---------------------------------------------------------------------- group

const TRUST_MEANING =
  '可信的群里 agent 可以谈主人的私事和本机细节（路径、主机、账号等），用于主人自己的 bot 之间交接；' +
  '不可信的群里一律不谈，主人问也不谈。凭据和密钥在哪里都不输出。'

const NAME_SOURCE = {
  owner: '主人设置的名字',
  qq: 'QQ 上的群名',
  openid: '没拿到群名，用 openid 前 8 位代替',
}

const RECV_SETTING: Record<string, string> = {
  all: '全部消息',
  only_mention: '只收 @ 本 bot 的消息',
  mention_and_context: '@ 本 bot 的消息及其上下文',
}

const ROLE: Record<string, string> = { owner: '群主', admin: '管理员', member: '成员' }

async function groupInfoText(deps: CommandDeps): Promise<string> {
  const { info, bot } = await deps.groupInfo()
  const shown = deps.groupName()!
  const lines = [
    '**群信息**',
    `显示名：${shown.name}（${NAME_SOURCE[shown.source]}）`,
    `可信：${deps.trusted() ? '是' : '否'}（\`/group trust on|off\`）`,
  ]
  if (typeof info === 'string') lines.push(`群资料：查询失败（${info}）`)
  else {
    if (info.group_name && info.group_name !== shown.name) lines.push(`QQ 群名：${info.group_name}`)
    if (typeof info.group_member_num === 'number') lines.push(`成员数：${info.group_member_num}`)
  }
  if (typeof bot === 'string') lines.push(`本 bot 状态：查询失败（${bot}）`)
  else {
    if (bot.member_role) lines.push(`本 bot 身份：${ROLE[bot.member_role] ?? bot.member_role}`)
    if (bot.recv_msg_setting) {
      lines.push(`接收消息：${RECV_SETTING[bot.recv_msg_setting] ?? bot.recv_msg_setting}（\`${bot.recv_msg_setting}\`）`)
    }
    if (typeof bot.allow_proactive_msg === 'boolean') lines.push(`允许主动消息：${bot.allow_proactive_msg ? '是' : '否'}`)
  }

  // The model is only known to a live session; a parked one has none to ask.
  let model = '会话未运行'
  const q = deps.query()
  if (q) {
    try {
      model = `\`${(await q.getContextUsage())?.model ?? '?'}\``
    } catch {
      model = '?'
    }
  }
  lines.push(
    '',
    `工作目录：\`${deps.workdir()}\``,
    `模型：${model}`,
    `权限模式：\`${deps.permissionMode()}\``,
    `verbose：\`${deps.verbose()}\``,
  )
  return lines.join('\n')
}

// ------------------------------------------------------------------- restart
//
// Without a supervisor the process would simply die and nothing would answer
// QQ until someone reached the machine, so /restart refuses that case.

async function refuseUnsupervised(deps: CommandDeps): Promise<void> {
  await deps.reply(
    '这个进程不是由系统服务启动的，退出后没有东西会把它拉起来，所以不执行。' +
      '用 `service/install.sh`（Windows 用 `service/install.ps1`）装成服务后再试。',
  )
}

const SUPERVISOR_WORDS = {
  launchd: 'launchd 会立刻把它拉起来',
  schtasks: '计划任务的 watchdog 会在一分钟内把它拉起来',
}

/**
 * Run `text` as a command. Returns false when it is not one, so the caller can
 * pass it through to the agent.
 */
export async function dispatch(text: string, deps: CommandDeps): Promise<boolean> {
  const m = /^\s*\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text)
  if (!m) return false
  // Real names resolve first, so an alias colliding with one is dead weight
  // rather than a way to shadow the command it collides with.
  const key = m[1].toLowerCase()
  const cmd = registry.get(key) ?? aliasMap.get(key)
  if (!cmd) return false

  const arg = (m[2] ?? '').trim()
  if (!usableIn(cmd, deps.where())) {
    await deps.reply(
      cmd.scope === 'private' ? `\`/${cmd.name}\` 只能在私聊里用。` : `\`/${cmd.name}\` 只能在群里用。`,
    )
    return true
  }
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
