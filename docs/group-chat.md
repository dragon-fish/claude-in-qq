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
- 斜杠命令作用于发出它的对话，群里只有主人能用；op 发的斜杠命令当普通消息交给 agent。审批统一发到主人私聊。
- 工作目录、模型、权限模式、verbose 按会话持久保存，在哪个对话里设就对哪个生效（如在 IPE 群里 `/cwd` 到
  IPE 仓库，该群此后一直在那里）。新群默认：verbose `off`，工作目录 `~`，模型与权限模式取全局默认。
- 重启后只有写了唤醒便条的会话会被主动拉起；其余群会话等下次被 @ 时才恢复，那一轮附带重启提示，不主动发言。
- 唤醒便条按会话分开：私聊仍是状态目录的 `wake.md`；群会话是 `wake/<group_openid>.md`，投递给对应群会话，
  回复挂在该群最近的消息上（没有则主动消息）。在哪个对话里 `/reload 附言`，附言就写进哪个对话的便条。
  投递后各自清空并留 `.last`。

## 消息包装

每轮 user 消息参照 sili 的协议：

```xml
<turn_context>
来源：群「测试群」(group_openid) / 私聊
发言人：机智的小鱼君⚡️ (member_openid)，主人：是/否，bot：是/否
时间：…
最近群消息：（最近 10 条，触发消息之前）
</turn_context>
<quoted_message author="…" message_id="…">…</quoted_message>   <!-- 仅引用时 -->
<user_message>原话（@ 已转为 @昵称）</user_message>
```

operator context 增加一节说明各块含义：只回应 `<user_message>`；不复述 `<turn_context>`；非主人发言时的行为准则。

## 群历史

- `node:sqlite`（bun ≥ 1.4 支持；不用 `bun:sqlite`，运行时私有接口），库在状态目录 `history.db`。表：`messages(group_openid, message_id, author_openid,
  author_name, is_bot, content, mentions_json, created_at)`。每群保留 30 天，启动时和每小时清理一次。
- 工具 `qq_group_history(group?, limit?, before_message_id?, query?)`：默认当前会话所在群，返回带 id 的消息列表。
- 本 bot 自己发到群里的消息也入库。

## 群里的回复

- 默认挂在触发消息上被动回复；能流式就流式，不能则按现有逻辑退回普通发送。
- 主动发起（如主人在私聊里让它去群里找另一个 bot）时，挂在该群最近 5 分钟内的任一条消息上；没有则同下。
- 被动窗口过期后先试群主动消息；失败则发到主人私聊，注明来自哪个群、回复的是哪条消息。
- agent 输出里的 `<@member_openid>` 原样保留为 QQ @；`@备注名`（op 列表里的）转成 `<@id>`。

## 待实现时验证

- bot 发出的 `<@id>` 能否让对方 bot 收到 `is_you: true`。
- 群消息能否用流式接口。
- 引用回复在事件里的字段（`message_reference` 或其他）。
