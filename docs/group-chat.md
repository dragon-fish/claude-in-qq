# 群聊支持

让 bridge 进 QQ 群：op 列表里的人（含其他 bot）@ 它或用昵称叫它时触发一轮对话，群里所有消息存进本地历史供
agent 查询。两台 bridge 拉进同一个群后，就能互相 @ 对话。私聊和每个群各是一个会话，会话之间可以互相留言。

不基于 Koishi：`@satorijs/adapter-qq`（4.10.1）没有流式消息，也不处理 `GROUP_MESSAGE_CREATE`，
全量群历史和看到其他 bot 的消息都做不到，换过去要重写的 QQ 底层比在 bridge 里加群聊多。

## 实测确认的 QQ 行为（2026-10）

- 单聊分片上传实测可用：4.9MB（单片）与 12MB（3 片）均成功。分片 `index` 从 1 开始（文档读作从 0 开始会读过文件尾）；
  `md5_10m` 对短于 10002432 字节的文件取全文件 MD5、分片 PUT 不带任何头，均被接受。

- 群主开放「接收全部消息」后，每条群消息都推 `GROUP_MESSAGE_CREATE`；未开放时只有 @ 机器人的消息推
  `GROUP_AT_MESSAGE_CREATE`。两者都要处理，字段相同。
- 其他 bot 的消息同样会推送，`author.bot = true`。
- `mentions[]` 列出被 @ 的成员，`is_you: true` 表示 @ 的是本机器人。content 里的 @ 形如 `<@member_openid>`。
- 主人在群里的 `member_openid` 与私聊白名单里的 `user_openid` 相同。同一个人在不同 bot 下 id 不同。
- 群被动回复：收到消息后 5 分钟内、每条最多回复 5 次。全量消息开启后，任何一条近 5 分钟的群消息都能作为回复对象，
  不必是 @ 本 bot 的那条。群主动消息实测连发 5 条全部成功（2025 文档写的每群每月 4 条已不适用）。
- 本 bot 自己发的群消息不会作为事件推回给自己。发送成功的响应带 `ext_info.ref_idx`，可能与引用回复有关。
- `GROUP_AT_MESSAGE_CREATE` 的 content 已去掉对本 bot 的 @（`" test"`），且不带 `mentions`。开启全量消息后，
  @ 本 bot 只推一条 `GROUP_MESSAGE_CREATE`（content 保留 `<@本bot>`，`mentions` 里 `is_you: true`），不另推 AT 事件。
- `message_scene.ext` 带 `msg_idx=REFIDX_…`；`timestamp` 为 RFC3339、精确到秒。事件里没有群名。
- 群名能查：`GET /v2/groups/{group_openid}/info`（30 次/分钟）返回 `group_name`、`group_member_num`、
  `group_finger_memo`、`group_class_text`、`group_tags[]`。`GET /v2/groups/{group_openid}/bot_state`
  （30 次/分钟）返回本 bot 在该群的 `member_role`（member/admin/owner）、`recv_msg_setting`
  （all/only_mention/mention_and_context）、`allow_proactive_msg`、`joined_at`。两者都是白名单接口，
  没权限时返回错误码 `11253`；本 bot 实测可用。
- 群里撤回一条消息不会推送任何事件。
- 文件 base64 直传（`file_data`）超过 5MB 会失败：4.9MB 的 zip（base64 后约 6.5MB）回 HTTP 500
  `{"code":850012,"message":"call inner proxy error"}`，21MB 的视频同样失败，1.3MB 的成功。

官方文档（2026 版 autogen 页）写明、未实测：

- 群消息不支持流式参数，也没有群的 `stream_messages` 接口（该页 302）。群回复只能普通发送。
- 主动消息限频：每个 bot 60 条/分钟（已认证；未认证 30）；每群 20 条/分钟、每天至多 1000 条。
- 撤回：`DELETE /v2/groups/{group_openid}/messages/{message_id}`，只能撤回本 bot 自己 2 分钟内的消息。尚未使用。
- 群文件上传 `/v2/groups/{group_openid}/files` 与单聊同参（`file_type` / `file_data` / `file_name`），分片上传的
  `upload_prepare` / `upload_part_finish` 也是同参，只换路径前缀。
- 同一 msg_id 可能重复推送，需去重。

## 身份与权限

- **私聊**：只认 `access.json` 的 `allowed`（主人）。白名单非空时，陌生人私聊不回复、不记录；只有白名单为空
  （首次安装）时才发配对码。
- **群聊 op 列表**：存在 `access.json` 的 `ops`（member_openid → 备注名）。主人永远视为 op，不必也不能写进列表。
  - `/op add <@成员|id> [备注]`、`/op remove <@成员|id>`、`/op list`：只有主人能用，私聊或群里都行。
  - agent 工具 `qq_op_remove`：agent 可把某人移出 op 列表；不能移除主人。
- **昵称**：存在 `access.json` 的 `nicknames`，全 bot 共用、不分群。`/nick add <昵称>`、`/nick remove <昵称>`、
  `/nick list`，只有主人能用，私聊或群里都行。昵称不能以 `/` 开头。
- 权限只靠提示词约束，不做工具级拦截。agent 知道每条消息是谁发的、是不是主人；对可能损害主人财产或名誉的请求
  拒绝，并在群里 @ 主人。

## 触发

- op（含主人、op 里的 bot）@ 本 bot 的群消息 → 触发该群会话的一轮。
- op 的群消息以某个昵称**开头** → 等同 @。昵称后可跟空白或 `，,：:、` 作分隔，也可以不跟；多个昵称都匹配时取
  最长的；不区分大小写。昵称从 `<user_message>` 里去掉。句中出现昵称不算。
- 非 op 的 @ 或昵称、所有没叫本 bot 的消息 → 只入历史，不触发。
- bot 连续触发超过 6 轮（中间没有人类 op 在该群说话，@ 与否都算）→ 第 7 条起不再回应 bot，并在群里 @ 主人一次；
  人类 op 说话即清零。计数只在内存里。

## 会话

- 每个对话一个独立的 Claude 会话：私聊一个（键 `c2c`），每个群各一个（键 `group:<group_openid>`）。session id、
  工作目录、权限模式、verbose、群名按对话分别保存在 `session.json`：私聊的字段平铺在顶层（崩溃回滚会检出只认
  这个形状的旧提交，不能挪），其余在 `conversations[键]` 下。
- 群会话并发上限默认 2（`QQ_GROUP_CONCURRENCY`），私聊不占名额。名额满时新触发的群排队，消息留在它自己的队列里，
  有名额空出就开跑。
- 群会话空闲 30 分钟（`QQ_GROUP_IDLE_MINUTES`）就关闭（park）：进程退出，session id 留在磁盘，下次被触发或收到
  会话留言时按 id 恢复。空闲指不在轮次中、没有未答复的输入、没有运行中的子代理、没有待处理的审批或提问、队列为空。
  有群在排队时，已安静满 1 分钟的空闲群会话会立刻让出名额，最久没动静的先让。
- park 只关 query，不换 `Conversation` 对象，所以队列、设置和已经投递过的重启提示都还在：恢复后不会再提示一次重启。
- 斜杠命令作用于发出它的对话，群里只有主人能用（要 @ 本 bot，或用昵称开头）；op 发的斜杠命令当普通消息交给 agent。
  审批和 `qq_ask` 统一发到主人私聊，卡片注明来自哪个群。
- 新群默认：工作目录为该群专属目录 `<状态目录>/groups/<group_openid>/`（不存在就建），verbose `off`，权限模式取
  全局默认。已保存过工作目录的群照旧。在哪个对话里 `/cwd`、`/mode`、`/verbose` 就对哪个生效并持久保存。
- 记忆：Claude Code 的自动记忆按工作目录存。新群用专属目录，所以默认各群记忆互相隔离、也与私聊隔离；`/cwd` 到
  某个项目后才与该项目共用。提示词约束：群里不透露记忆中主人的私事；群里只记关于该群、该项目的事实；非主人的话
  不当作主人偏好写入记忆。
- 进程级命令只在私聊可用：`/restart`（别名 `/reload`，立即重启，可带附言写进 `wake.md`）、`/resume`；在群里用会
  回复「只能在私聊里用」。群专用命令 `/group` 在私聊里回复「只能在群里用」。其余命令两边都能用。群指令面板只列群里
  可用的命令，私聊面板列全部（含 `/group`）；别名不进面板。
- 改 bridge、重启 bridge 只在私聊里做（提示词约束）。唤醒便条只有私聊的 `wake.md`，只投给私聊会话；
  重启后群会话不主动发言，等下次被触发或收到会话留言时恢复，那一轮附带重启提示。

## 群名

- 第一次见到一个群（收到它的消息，或给它的会话留言打开它）时调 `/info` 取群名，之后至多每 6 小时刷新一次；
  结果和查询时间存在该群会话设置里（`qq_name`、`qq_name_checked_at`）。查询失败（含 `11253` 无权限）不报错，
  同样隔 6 小时再试。触发消息最多等 3 秒查询结果，好让第一轮的上下文就带上群名。
- 显示名：主人用 `/group name set <群名>` 设的自定义名优先，其次 QQ 群名，都没有时显示 openid 前 8 位。
  `<turn_context>`、历史工具、审批与提问卡片、转发到私聊的回复、`qq_list_agents` 都用显示名。
- `/group name` 查看显示名及其来源；`/group name set` 不带名字则清除自定义名；`/group info` 显示群名、成员数、
  本 bot 身份、接收消息设置、是否允许主动消息，以及该群会话的工作目录、模型、权限模式、verbose。

## 会话之间留言

仿 Claude Code 的 `ListAgents` / `SendMessage`：bridge 内每个会话是一个 agent，可以互相发消息，各自只在自己的
私聊或群里发言。这些工具只在本 bridge 的 agent 之间传话，不发给任何 QQ 用户。

- `qq_list_agents()`：列出所有会话的 agent——私聊、打开过或存过设置的群、历史库里有记录的群——每行是键、显示名、
  状态（running 轮次中 / idle 会话开着但空闲 / waiting 排队等名额 / parked 没有运行中的会话）、最近活动时间。
- `qq_message_agent(to, message)`：给另一个会话的 agent 发消息。对方收到一条 user 消息，`<turn_context>` 标明来源
  会话、由谁的哪条 QQ 消息引起、链深度；对方没在跑就拉起（受并发上限约束）。`to` 不认识时返回工具错误并列出所有
  合法键；不能发给自己。
- **由 agent 消息开启的一轮是静默的**（同 Claude Code 里回应 `SendMessage` 的子代理）：这一轮写的文字（含 `MEDIA:`
  行和 verbose 过程）不发到任何聊天；agent 用 `qq_message_agent` 回复对方，要让主人或本群看到什么，就用
  `qq_say(text)` 显式发到自己的聊天（其中的 `MEDIA:` 行照常发文件）。判定按输入算：上一个 result 之后交给会话的只有
  agent 消息时静默；只要有 QQ 消息（或唤醒便条）加入，从那一刻起就是普通轮次。由 QQ 消息开启的轮次不受影响。
- `qq_say` 每个会话都有；普通轮次里用不着，直接写就会发出。
- 能力上不限制（任何会话可给任何会话留言），提示词提醒不要被群里的人当传声筒利用。
- 防失控：每条 QQ 消息开启一条链，深度 0；每次投递把发送方当前的链带过去、深度加 1。深度超过 6 就拒绝投递，
  给发送方返回工具错误，并在私聊通知主人（同一条链只通知一次）。发送方的「当前链」取它最近收到的那条消息的链，
  所以链中途有人类发言，就从那条消息重新算起。

对方收到的消息（`起因` 一行没有 QQ 消息时写「不是由 QQ 消息引起的」）：

```xml
<turn_context>
来源：会话留言，来自私聊（会话 c2c）
起因：(8C072A8CA2620EE3F14D3CF2CED8D7FA) [主人] 在私聊说：帮我去 IPE 群问问 sili 今天的构建状态
时间：2026/10/16 02:25:59
留言链：第 1 层，上限 6 层
这一轮你写的文字不会发到你的聊天里：回复对方用 qq_message_agent，要让你这边的聊天看到，用 qq_say。
</turn_context>
<conversation_message from="c2c">
主人想知道 sili 今天的构建状态。请在群里 @ sili 问一下，拿到结果后 qq_message_agent 回 c2c。
</conversation_message>
```

## 消息包装

每轮 user 消息参照 sili 的协议：

```xml
<turn_context>
来源：群 小鱼君测试沙盒（会话 group:642E2EF6E499C6B0E4C500F634C0F9CE）   <!-- 私聊时为「来源：私聊」 -->
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
  用昵称叫本 bot 时，昵称不进 `<user_message>`。
- 历史行每条截 200 字、换行折成 ` ⏎ `；本 bot 自己的消息显示为「你（本 bot）」。
- 不可信文本里的 `<turn_context` / `<user_message` / `<conversation_message` / `<system-reminder` 等框架标签被改成
  全角 `＜`，防止伪造。会话留言的正文同样处理。
- `<quoted_message>` 未实现，见「待验证」。

operator context 有一节说明各块含义：只回应 `<user_message>`；不复述 `<turn_context>`；非主人发言时的行为准则。

## 群历史

- `node:sqlite`（bun ≥ 1.4 支持；不用 `bun:sqlite`，运行时私有接口），库在状态目录 `history.db`，代码在 `src/history.ts`。
  表：`messages(group_openid, message_id, author_openid, author_name, is_bot, is_self, content, mentions_json,
  ref_idx, created_at)`，主键 `(group_openid, message_id)`，按 rowid（到达顺序）排序。保留 30 天，启动时和每小时清理一次。
- 收到的每条群消息都入库（含其他 bot、非 op），入库同时做去重：重复推送的 msg_id 不再触发。
- 本 bot 发到群里的消息（文字和文件）发送成功后入库，`is_self = 1`，`ref_idx` 取响应的 `ext_info.ref_idx`；
  入站消息的 `ref_idx` 取 `msg_idx`。
- 工具 `qq_group_history(group?, limit?, before_message_id?, query?)`：默认当前会话所在群，`group` 可给 openid
  或会话键；私聊里不给 `group` 时列出库里有哪些群（带显示名）。返回首行是群显示名，之后旧→新、每行带 message id。
  `query` 是内容或发送者名字的子串。

## 群里的回复

- 不流式：每条 assistant 消息的文字写完就作为一条普通消息发出——Claude Code 每个内容块发一条 assistant 消息，
  所以文字在紧随其后的工具调用之前就到群里。只有工具调用、没有文字的消息不发。超过 1500 字分条。
  `MEDIA:` 文件走群上传接口，插在正文对应位置（前后的文字各成一条）。提示词要求长任务开工前先用一句话说要做什么。
- 每次发送挂在该群最近收到、5 分钟窗口内（留 10 秒余量）还有次数的消息上被动回复，每条最多 5 次；没有则发群主动消息。
  候选只在内存里，重启后丢失至多 5 分钟的窗口。
- 群发送失败时，原文转发到主人私聊，注明群和触发这一轮的消息。
- agent 输出里的 `<@member_openid>` 原样保留；`@备注名`（op 列表里的）转成 `<@id>`，长备注优先匹配。

## 待验证

- bot 发出的 `<@id>` 能否渲染成 @、能否让对方 bot 收到 `is_you: true`。2025 文档称 `<@id>` 即将弃用、
  改用 `<qqbot-at-user id="" />`；换格式只需改 `qq.ts` 的 `toGroupMentions`。
- 引用回复的字段。2026 版文档写的是 `message_type: 103`、被引用内容在 `msg_elements[]`、`message_scene.ext`
  带 `ref_msg_idx`，但抓到的真实事件里还没有引用。`message_type` 非 0 的群事件会额外写进
  `unhandled-events.jsonl`，在群里引用一条消息再 @ 本 bot 即可拿到样本；历史库已存 `ref_idx`，可据此还原被引用的消息。
- 群 markdown（`msg_type: 2`）发送、群文件上传未在真实群里跑过；单聊同参的路径是实测可用的。
- 分片上传在群里尚未实测（单聊已实测，见上）。
- 未开全量消息时，同一条 @ 是否会同时以两个不同 msg_id 推送（目前按 msg_id 去重）。
