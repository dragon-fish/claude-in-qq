# claude-qq-channel

把 QQ 私聊变成 Claude Code 的遥控器。消息进入**本机正在运行的 CC 会话**，Claude 用你真实的
skills / CLAUDE.md / hooks 干活；需要审批的工具调用转发到 QQ，回一句 `yes <id>` 就放行。

基于官方 [Channels](https://code.claude.com/docs/en/channels)（research preview）实现。

## 当前状态

已验证可用：

- [x] 扫码配置：一次表都不用填，腾讯侧自动建 bot 应用并加好友
- [x] 凭据解密（AES-256-GCM）与落盘（`~/.claude/channels/qq/.env`，600）
- [x] 扫码者 openid 自动进白名单
- [x] WebSocket 网关连接（`gateway connected` → `ready`）

尚未验证：

- [ ] 端到端：QQ 发消息 → CC 会话收到 → Claude 回复到 QQ
- [ ] 权限中继：QQ 收到审批请求 → 回 `yes <id>` → 工具放行
- [ ] 常驻方式（见下）

## 明天从这里继续

### 1. 起一个带 channel 的会话

首次启动要过三个一次性确认框（development channel 警告、新 MCP server 授权、workspace trust）：

```bash
cd ~/GitRepositories/claude-qq-channel
claude --dangerously-load-development-channels server:qq
```

> ⚠️ 不要用 `claude` 这个 alias —— `~/.zshrc:183` 把它定义成了带
> `--dangerously-skip-permissions`，那会让所有远程会话跳过权限检查，而 QQ 端根本看不出来。
> 用 `claude-safe`，或直接写 `/Users/you/.local/bin/claude`。

起来后 QQ 里的 bot 会从「离线」变「在线」（在线状态 = 本进程的网关连接）。
然后用手机 QQ 私聊 bot 发一句话，看会不会出现在会话里。

### 2. 决定常驻方式

`tmux` 不是必须的，它只是给交互式 CC 一个 TTY。三条路按优先级：

| 方案 | 开机自启 | 待验证 |
| --- | --- | --- |
| launchd + `claude -p` | ✅ | `-p` 能否长驻等 channel 事件；启动确认框在非交互下如何表现 |
| launchd + `script -q -c '...' /dev/null` 伪 TTY | ✅ | 伪 TTY 下确认框能否自动过 |
| tmux | ❌ 重启不恢复 | 无 |

官方文档提到 `-p` 模式下需要终端输入的工具会被自动禁用，所以会话不会卡住等输入——这是方案
一可行的依据，但要实测。

**launchd 必须显式注入代理环境变量**（不读 `.zshrc`）。clash 规则会把大陆流量改写为 direct，
所以 `q.qq.com` 照常带代理即可，不用 `no_proxy`。

### 3. 补完

- [ ] 端到端跑通后，把 `.mcp.json` 改成插件形态（`${CLAUDE_PLUGIN_ROOT}`），或写进用户级
      `~/.claude.json` 用绝对路径，这样任意目录都能加载
- [ ] 消息长度上限 `MAX_CHUNK` 目前取保守的 1500，实测后按 QQ 真实限制调整
- [ ] 附件目前只转发 URL，没有下载

## 结构

```
server.ts            channel 主体：网关、入站 gate、reply 工具、权限中继、配额管理
onboard.ts           扫码配置：create_bind_task → 轮询 → AES-GCM 解密 → 落盘
skills/configure/    /qq:configure —— 扫码或手工填凭据、查状态
skills/access/       /qq:access —— 白名单与配对码管理
docs/DESIGN.md       协议要点、配额规则、安全模型、已知风险
```

## 已知风险

- **扫码用的 `/lite/create_bind_task` 和 `/lite/poll_bind_result` 不在腾讯公开文档里**，
  是从 Hermes 的实现里挖出来的（目标页 `q.qq.com/qqbot/openclaw/connect.html` 带 `openclaw`
  字样，是腾讯给这类 agent 工具开的口子）。今天实测可用，随时可能变。变了就退回手工注册
  应用 + `/qq:configure <app_id> <secret>`，这条路径已保留。
- **Channels 是 research preview**，`--channels` 语法和协议契约官方明示可能变动。
- **白名单即审批权限**。能通过 channel 回消息的人就能批准工具调用，所以只加你自己。
- `access.json` 缺失或损坏时按空白名单处理（拒绝所有），不是放行。
