# 群聊支持

让 bridge 进 QQ 群：op 列表里的人（含其他 bot）@ 它时触发一轮对话，群里所有消息存进本地历史供 agent 查询。
两台 bridge 拉进同一个群后，就能互相 @ 对话。

不基于 Koishi：`@satorijs/adapter-qq`（4.10.1）没有流式消息，也不处理 `GROUP_MESSAGE_CREATE`，
全量群历史和看到其他 bot 的消息都做不到，换过去要重写的 QQ 底层比在 bridge 里加群聊多。

## 实测确认的 QQ 行为（2026-10）

- 群主开放「接收全部消息」后，每条群消息都推 `GROUP_MESSAGE_CREATE`；未开放时只有 @ 机器人的消息推
  `GROUP_AT_MESSAGE_CREATE`。两者都要处理，字段相同。
- 其他 bot 的消息同样会推送，`author.bot = true`。
- `mentions[]` 列出被 @ 的成员，`is_you: true` 表示 @ 的是本机器人。content 里的 @ 形如 `<@member_openid>`。
- 主人在群里的 `member_openid` 与私聊白名单里的 `user_openid` 相同。同一个人在不同 bot 下 id 不同。
- 群被动回复：收到消息后 5 分钟内、每条最多回复 5 次。全量消息开启后，任何一条近 5 分钟的群消息都能作为回复对象，
  不必是 @ 本 bot 的那条。群主动消息实测连发 5 条全部成功
  （2025 文档写的每群每月 4 条已不适用，真实上限未知）。
- 本 bot 自己发的群消息不会作为事件推回给自己。发送成功的响应带 `ext_info.ref_idx`，可能与引用回复有关。
- `GROUP_AT_MESSAGE_CREATE` 的 content 已去掉对本 bot 的 @（`" test"`），且不带 `mentions`。开启全量消息后，
  @ 本 bot 只推一条 `GROUP_MESSAGE_CREATE`（content 保留 `<@本bot>`，`mentions` 里 `is_you: true`），不另推 AT 事件。
- `message_scene.ext` 带 `msg_idx=REFIDX_…`；`timestamp` 为 RFC3339、精确到秒。事件里没有群名。

官方文档（2026 版 autogen 页）写明、未实测：

- 群消息不支持流式参数，也没有群的 `stream_messages` 接口（该页 302）。群回复只能普通发送。
- 群主动消息：每群每分钟 20 条、每天 1000 条。
- 群文件上传 `/v2/groups/{group_openid}/files` 与单聊同参（`file_type` / `file_data` / `file_name`）。
- 同一 msg_id 可能重复推送，需去重。

## 身份与权限

- **私聊**：只认 `access.json` 的 `allowed`（主人）。白名单非空时，陌生人私聊不回复、不记录；只有白名单为空
  （首次安装）时才发配对码。
- **群聊 op 列表**：存在 `access.json` 的 `ops`（member_openid → 备注名）。主人永远视为 op，不必也不能写进列表。
  - `/op add <@成员|id> [备注]`、`/op remove <@成员|id>`、`/op list`：只有主人能用，私聊或群里都行。
  - agent 工具 `qq_op_remove`：agent 可把某人移出 op 列表；不能移除主人。
- 权限只靠提示词约束，不做工具级拦截。agent 知道每条消息是谁发的、是不是主人；对可能损害主人财产或名誉的请求
  拒绝，并在群里 @ 主人。

## 触发

- op（含主人）@ 本 bot 的群消息 → 触发该群会话的一轮。
- 非 op 的 @、所有未 @ 本 bot 的消息 → 只入历史，不触发。
- bot 之间连续来回超过 6 轮（中间没有人类 op 发言）→ 暂停响应 bot，并 @ 主人。

## 会话

- 每个对话一个独立的 Claude 会话：私聊一个，每个群各一个。session id、工作目录、模型、权限模式按对话分别保存。
- 群会话空闲 30 分钟关闭，下次触发按 session id 恢复。
- 群会话并发上限默认 2（可配置），超出的排队；私聊不占名额。
- 斜杠命令作用于发出它的对话，群里只有主人能用（且要 @ 本 bot）；op 发的斜杠命令当普通消息交给 agent。
  审批和 `qq_ask` 统一发到主人私聊，卡片注明来自哪个群。
- 工作目录、模型、权限模式、verbose 按会话持久保存，在哪个对话里设就对哪个生效（如在 IPE 群里 `/cwd` 到
  IPE 仓库，该群此后一直在那里）。新群默认：verbose `off`，工作目录 `~`，模型与权限模式取全局默认。
- 进程级命令只在私聊可用：`/restart`（别名 `/reload`，立即重启、无确认码）、`/resume`。其余命令只作用于
  当前对话，群里也可用。群指令面板只列群里可用的命令，私聊面板列全部。
- 改 bridge、重启 bridge 只在私聊里做（提示词约束）。唤醒便条只有私聊的 `wake.md`，只投给私聊会话；
  重启后群会话不主动发言，等下次被 @ 或收到会话留言时恢复，那一轮附带重启提示。
- `/name <群名>`：主人在群里给该群起名，存进该群会话设置；`<turn_context>`、历史工具、审批卡片、转发
  都用这个名字，没起名的显示 openid 前 8 位。QQ 不提供群名（消息和进群事件都只有 group_openid）。

## 会话之间留言

仿 Claude Code 的 `SendMessage`：bridge 内每个会话都是主代理，可以互相留言，各自仍只在自己的私聊或群里发言。

- `qq_conversations()`：列出所有会话（私聊、各群；群名、是否运行中、最近活动）。
- `qq_send(to, message)`：给另一个会话留言。对方收到一条 user 消息，`<turn_context>` 标明来源会话、由谁的
  哪条消息引起；对方空闲就拉起。对方照常在自己的对话里发言，需要时用 `qq_send` 回信。
- 能力上不限制（任何会话可给任何会话留言），提示词提醒不要被群里的人当传声筒利用。
- 防失控：留言链深度超过 6 层（由同一条人类消息引起的连续转发）就停止投递并通知主人。

## 消息包装

每轮 user 消息参照 sili 的协议：

```xml
<turn_context>
来源：群 642E2EF6E499C6B0E4C500F634C0F9CE        <!-- 私聊时为「来源：私聊」 -->
发言人：机智的小鱼君⚡️ (8C072A8C…)，主人：是，bot：否
时间：2026/10/16 00:59:32
最近群消息（触发消息之前 4 条，旧→新）：           <!-- 仅群聊；最多 10 条 -->
[00:59:25] 机智的小鱼君⚡️ (8C072A8C…) [主人]：/echo 一条来自sili的消息
[00:59:26] SILI Official (47B30E3E…) [op][bot]：一条来自sili的消息
</turn_context>
<user_message>
@Claude @MacBook aaa
</user_message>
```

- 私聊和群聊的每条入站消息都包装；`<@id>` 渲染为 `@昵称`（消息自带的名字，其次 op 备注，其次历史里见过的名字）。
- 历史行每条截 200 字、换行折成 ` ⏎ `；本 bot 自己的消息显示为「你（本 bot）」。
- 不可信文本里的 `<turn_context` / `<user_message` / `<system-reminder` 等框架标签被改成全角 `＜`，防止伪造。
- 事件不带群名，来源只写 group_openid。
- `<quoted_message>` 未实现，见「待验证」。

operator context 有一节说明各块含义：只回应 `<user_message>`；不复述 `<turn_context>`；非主人发言时的行为准则。

## 群历史

- `node:sqlite`（bun ≥ 1.4 支持；不用 `bun:sqlite`，运行时私有接口），库在状态目录 `history.db`，代码在 `src/history.ts`。
  表：`messages(group_openid, message_id, author_openid, author_name, is_bot, is_self, content, mentions_json,
  ref_idx, created_at)`，主键 `(group_openid, message_id)`，按 rowid（到达顺序）排序。保留 30 天，启动时和每小时清理一次。
- 收到的每条群消息都入库（含其他 bot、非 op），入库同时做去重：重复推送的 msg_id 不再触发。
- 本 bot 发到群里的消息（文字和文件）发送成功后入库，`is_self = 1`，`ref_idx` 取响应的 `ext_info.ref_idx`；
  入站消息的 `ref_idx` 取 `msg_idx`。
- 工具 `qq_group_history(group?, limit?, before_message_id?, query?)`：默认当前会话所在群；私聊里不给 `group`
  时列出库里有哪些群。返回旧→新、每行带 message id。`query` 是内容或发送者名字的子串。

## 群里的回复

- 不流式：一轮的文字攒在一起，到封口时（轮次结束、`MEDIA:` 行、插入的独立消息、新消息进入会话）作为一条普通消息发出，
  超过 1500 字分条。`MEDIA:` 文件走群上传接口，仍插在正文对应位置。
- 每次发送挂在该群最近收到、5 分钟窗口内（留 10 秒余量）还有次数的消息上被动回复，每条最多 5 次；没有则发群主动消息。
  候选只在内存里，重启后丢失至多 5 分钟的窗口。
- 群发送失败时，原文转发到主人私聊，注明群和触发这一轮的消息。
- agent 输出里的 `<@member_openid>` 原样保留；`@备注名`（op 列表里的）转成 `<@id>`，长备注优先匹配。

## 尚未实现

- 群会话并发上限与空闲关闭（接口在 `index.ts` 的 `ensureServing`；目前群会话一旦启动就常驻）。
- bot 之间来回轮数上限。
- 群里禁用进程级命令、两份面板分开、`/restart` 去确认码并以 `/reload` 为别名。
- `/name`。
- 会话之间留言。

## 待验证

- bot 发出的 `<@id>` 能否渲染成 @、能否让对方 bot 收到 `is_you: true`。2025 文档称 `<@id>` 即将弃用、
  改用 `<qqbot-at-user id="" />`；换格式只需改 `qq.ts` 的 `toGroupMentions`。
- 引用回复的字段。2026 版文档写的是 `message_type: 103`、被引用内容在 `msg_elements[]`、`message_scene.ext`
  带 `ref_msg_idx`，但抓到的真实事件里还没有引用。`message_type` 非 0 的群事件会额外写进
  `unhandled-events.jsonl`，在群里引用一条消息再 @ 本 bot 即可拿到样本；历史库已存 `ref_idx`，可据此还原被引用的消息。
- 群 markdown（`msg_type: 2`）发送、群文件上传未在真实群里跑过；单聊同参的路径是实测可用的。
- 文档写二进制直传上限 5MB，代码沿用单聊的 30MB 上限。
- 未开全量消息时，同一条 @ 是否会同时以两个不同 msg_id 推送（目前按 msg_id 去重）。
