# claude-qq-channel 设计

把 QQ 私聊变成 Claude Code 的遥控器。消息进入**本机正在运行的 CC 会话**，Claude 用你真实的
skills / CLAUDE.md / hooks 干活，结果回到 QQ；需要审批的工具调用转发到 QQ 由你远程放行。

## 目标与非目标

**目标**

- 从 QQ 私聊向本机 CC 会话下达指令，并收到回复
- 工具审批（Bash / Write / Edit 等）转发到 QQ，回 `yes <id>` / `no <id>` 远程放行
- 只有白名单发送者能推消息，且能审批

**非目标**

- 群聊。只做 C2C 私聊
- 多用户 / 多租户。单人自用
- 自建审批 UI。用官方 permission relay 的纯文本协议

## 架构

```
腾讯 QQ 开放平台 WebSocket 网关
   │  C2C_MESSAGE_CREATE
   ▼
server.ts  (Bun · MCP server over stdio)
   ├─ gate()        按 user_openid 白名单，非白名单静默丢弃
   ├─ 配对          陌生人首发 → 回配对码 → CC 里 /qq:access pair <code>
   ├─ 入站          → notifications/claude/channel
   ├─ reply 工具    ← Claude 调用 → POST /v2/users/{openid}/messages
   ├─ 权限中继      permission_request → 发 QQ → 你回 yes/no → permission
   └─ 配额管理器    被动优先，超限降级主动
   ▲ stdio（Claude Code 把本进程作为子进程拉起）
   │
Claude Code 会话（宿主机）
```

## Channel 协议要点

来源：<https://code.claude.com/docs/en/channels-reference>。**研究预览阶段，协议可能变动。**

### 能力声明

```ts
capabilities: {
  experimental: {
    'claude/channel': {},             // 必须。注册 channel 监听器
    'claude/channel/permission': {},  // 开启权限中继
  },
  tools: {},                          // 暴露 reply 工具
}
```

`instructions` 字段会进 Claude 的系统提示词，需说明事件长什么样、怎么回复、回传哪个属性。

### 入站

```ts
mcp.notification({
  method: 'notifications/claude/channel',
  params: { content: '正文', meta: { user_openid: '...', msg_id: '...' } },
})
```

`meta` 的每个键成为 `<channel>` 标签属性。**键只能是字母数字下划线**，含连字符的会被静默丢弃。
`source` 属性由 server name 自动填充。

### 权限中继

Claude Code → server：`notifications/claude/channel/permission_request`

| 字段 | 说明 |
| --- | --- |
| `request_id` | 5 个小写字母，**字母表不含 `l`**（避免手机上与 `1`/`I` 混淆） |
| `tool_name` | `Bash` / `Write` 等 |
| `description` | 这次调用的说明。Bash 在模型没给描述时是常量 `Run shell command`，**不含命令内容** |
| `input_preview` | 参数的 JSON 形式文本。Bash 的实际命令在这里 |

`description` 与 `input_preview` **均为不可信文本**，需当作潜在注入处理后再渲染。

server → Claude Code：`notifications/claude/channel/permission`，参数 `{ request_id, behavior: 'allow' | 'deny' }`。

本地终端对话框与 QQ 两边同时有效，**先到的答案生效**，另一边自动关闭。ID 不匹配的裁决被静默丢弃。

裁决正则（照抄官方，`/i` 容忍手机自动大写，回传前转小写）：

```ts
/^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
```

### 启动

自建 channel 不在 Anthropic 白名单内，必须：

```bash
claude --dangerously-load-development-channels server:qq
```

## QQ 开放平台要点

### 消息配额（C2C）

| 类型 | 判定 | 限制 |
| --- | --- | --- |
| 被动 | 填了 `msg_id` 或 `event_id` | 有效期 **60 分钟**，每条用户消息最多回 **4 次** |
| 主动 | 未填 | 接收方 20/qpm、**每天 1000 条**；发送方个人认证 10/qps，未认证 5/qps 且 30/qpm |

**配额管理器**：为每个 `msg_id` 记录 `(已用次数, 首次时间)`。发送时若该 msg_id 用量 < 4 且距首次 < 60
分钟，走被动；否则省略 msg_id 走主动。审批推送同样走这条路径。

### 端点

| 用途 | 方法与路径 |
| --- | --- |
| 取 token | `POST https://bots.qq.com/app/getAppAccessToken`，body `{appId, clientSecret}` |
| 取网关 | `GET https://api.sgroup.qq.com/gateway` |
| 发单聊 | `POST https://api.sgroup.qq.com/v2/users/{openid}/messages` |

鉴权头 `Authorization: QQBot <access_token>`。token 按 `expires_in` 提前刷新。

### WebSocket

标准 Discord 风格 opcode：`op 10` Hello（含 heartbeat_interval）→ `op 2` Identify → `op 1` 心跳 →
`op 0` Dispatch（`t: C2C_MESSAGE_CREATE`）→ 断线用 `op 6` Resume（带 session_id + seq）。

intents 只开 C2C 私聊相关位，不订阅群聊。

## 状态与配置

```
~/.claude/channels/qq/
├── .env          QQ_APP_ID / QQ_CLIENT_SECRET（由 /qq:configure 写入，权限 600）
└── access.json   白名单、待配对码、策略
```

`access.json`：

```jsonc
{
  "policy": "allowlist",              // allowlist | open（open 仅用于本地调试）
  "allowed": ["<user_openid>"],       // 白名单，按发送者 openid
  "pending": { "<code>": { "openid": "...", "expires_at": 0 } }
}
```

## 安全模型

1. **按发送者 openid 过滤，不是会话 id**。官方文档特别强调这一点：群场景下二者不同，按会话过滤
   等于放行该会话里的任何人。本项目虽只做私聊，仍按发送者过滤。
2. **白名单同时是审批权限边界**。能通过 channel 回消息的人就能批准工具调用，所以只加你自己。
3. **默认拒绝**。`access.json` 缺失或损坏时按空白名单处理，而不是放行。
4. **绝不自动提权**。参考实现里「陌生人发消息即自动成为 master」的做法是后门，本项目不做：
   陌生人只会拿到一个配对码，必须在本机 CC 会话里显式 `pair` 才生效。
5. **不可信文本**。`description` / `input_preview` 以及用户消息在拼进 QQ 文案前做转义。

## 已知风险

- **协议是研究预览**。`--channels` 语法与 channel 契约官方明示可能变动，升级 CC 后需回归验证。
- **会话必须活着**。事件只在 CC 会话运行时送达；关掉终端即失效。长期挂机需要 tmux/launchd 托管。
- **审批窗口 vs 配额**。长任务中途的审批推送若已超出 4 次被动额度，会降级为主动消息，受每天
  1000 条限制。单人使用不构成瓶颈，但值得在日志里可观测。
- **未上架 bot 受限于沙箱**。开发期只能在沙箱环境收发消息。
