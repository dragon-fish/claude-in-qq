# claude-in-qq

把 QQ 私聊变成 Claude Code 的遥控器。手机上发一句话，本机的 Claude Code 就开始干活——用你真实的
CLAUDE.md、skills、MCP，跑在真实的文件系统上。需要审批的工具调用变成 QQ 里的按钮，点一下放行。

不是聊天机器人，也不是借 CC 订阅跑别的 agent。是 Claude Code 本身，换了个前端。

## 能做什么

- **对话**：QQ 私聊直接就是 prompt。回复以 markdown 渲染，QQ 支持加粗、行内代码、列表、围栏代码块、
  链接、表格
- **审批**：工具调用弹按钮，点「允许」或「拒绝」。默认 `auto` 模式，只有模型判定有风险的操作才问
- **提问**：Claude 需要你拿主意时会推一组按钮出来，等同于 TUI 里的 AskUserQuestion
- **斜杠指令**：`/help` `/stop` `/clear` `/context` `/model` `/mode` `/resume` `/cwd` `/status`
- **图片进出**：发图给它看；它用 `MEDIA:/绝对路径` 把文件（截图、报表、日志）发回来
- **不掉线**：会话 ID 落盘，重启机器后接着上次的上下文聊
- **捎话**：本机任意目录的其他 CC 会话可以借这条通道给你发通知（见下）

## 架构

```
QQ 手机客户端
   │  C2C 私聊 / 按钮点击
   ▼
腾讯开放平台 WebSocket 网关
   │
   ▼
src/index.ts ──── Claude Agent SDK ──── Claude Code（订阅额度，非 API 计费）
   │                    │
   │                    └─ canUseTool → 审批按钮推回 QQ
   └─ src/qq.ts：凭据、白名单、配额、网关、键盘、媒体
```

关键在于 SDK **拥有**这个会话，而不是往别人的会话里推消息。所以常驻、审批中继、斜杠指令都只是普通
函数调用，不需要一个开着的终端。

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 主循环：消息进 SDK、事件出 QQ、审批与提问的中继 |
| `src/qq.ts` | 协议层，只认 QQ 不认 Claude |
| `src/commands.ts` | 斜杠指令注册表 |
| `src/notify.ts` | 单向通知入口，不经过主进程 |
| `src/onboard.ts` | 扫码配置 |
| `src/pair.ts` | 白名单管理，只能在本机跑 |
| `service/` | launchd 常驻 |

## 上手

```bash
bun install
bun run onboard          # 扫码，腾讯侧自动建应用并加好友
```

扫码的人自动进白名单。之后再有人给 bot 发消息，只会拿到一个配对码，**必须有人在这台机器上批准**：

```bash
bun run pair             # 看白名单和待配对
bun run pair <code>      # 批准
```

这条路径故意不走 QQ：白名单成员同时拥有批准工具调用的权限，让一条聊天消息就能授权，白名单就形同虚设。

装成常驻服务：

```bash
service/install.sh       # 从交互式 shell 跑，它要读你真实的 PATH 和代理
```

plist 由脚本现场生成，不进仓库——一份能用的 plist 必然带着这台机器的绝对路径、PATH 和可能含内网域名的
`no_proxy`。

```bash
launchctl kickstart -k gui/$UID/local.claude-in-qq    # 重启
launchctl bootout   gui/$UID/local.claude-in-qq       # 停止并卸载
tail -f ~/.claude/channels/qq/bridge.log              # 日志
```

## 捎话

任意目录的其他 CC 会话（或脚本、CI）可以给你的 QQ 发一条单向通知：

```bash
qq-notify --from "重构订单模块" "测试全绿，可以合了"
pytest 2>&1 | tail -20 | qq-notify --from "跑测试"
```

```bash
skills/install.sh        # 装命令和配套 skill，两个都是指向本仓库的软链
```

装完 `~/.local/bin/qq-notify` 指向 `src/notify.ts`，靠 shebang 执行——所以显示的工作目录是**调用方**的，
不是项目的。`~/.claude/skills/qq-notify` 指向 `skills/qq-notify`，于是你对任意 CC 说「做完了 QQ 喊我
一声」它就知道该干什么。软链而非拷贝，改仓库即生效，没有第二份要同步。

这一步和服务无关：不跑常驻服务也能发通知。

消息带上来源和目录，因为它落在你和 bridge 聊天的同一个窗口里。bridge 那个 Claude 也会在下次对话时
被告知有别的会话借用了通道——否则你提起某条消息，它会毫无印象。

**单向**：你的回复会进到 bridge 会话，不会回到发起方。所以只发结论，不要发问题。

## 安全模型

- **白名单即审批权**。能发消息的人就能批准工具调用，所以只加自己
- `access.json` 缺失或损坏时按空白名单处理（拒绝所有），不是放行
- 待审批的工具入参放在围栏代码块里，免得内容自己伪装成 markdown，让你看不清在批什么
- 默认 `auto` 权限模式。`/mode` 可切 `default`（每个危险操作都问），但不提供 `bypassPermissions`——
  那是给一次性容器用的，不该出现在一台你日常用的机器上
- 凭据存在 `~/.claude/channels/qq/.env`，权限 600

## 已知风险

- **扫码用的 `/lite/create_bind_task` 和 `/lite/poll_bind_result` 不在腾讯公开文档里**，随时可能变。
  变了就退回手工注册应用，把 `QQ_APP_ID` / `QQ_CLIENT_SECRET` 写进 `.env`，这条路径仍然可用
- **被动消息有配额**：回复携带 `msg_id` 时 60 分钟内最多 4 条，超出后自动转主动消息，主动消息
  1000 条/天。长任务的进度播报因此是节流的
- **按钮文字上限约 20 字**，且随屏幕宽度变化。选项过长时自动降级为截断标签，再不行退成 A/B/C/D
- Agent SDK 的 `resume` 跨目录续接依赖官方行为，`/cwd` 保留上下文正是建立在这上面
