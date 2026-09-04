---
name: patch-cc-in-qq
description: Use when asked to change the claude-in-qq bridge itself — its slash commands, QQ transport, streamed output, or session lifecycle — and whenever an edit to it has to take effect on the process that is already running.
---

# 改 claude-in-qq 这个桥接

claude-in-qq 让用户在 QQ 私聊里遥控 Claude Code。改它跟改别的仓库有一点根本不同：
**跑着的那个进程可能就是你自己**。

## 先确认你是不是跑在里面

如果你的 system prompt 说你通过 QQ 私聊被访问、对方在手机上，那就是你——你写的每句话
都经由这个桥接送出去，重启它会当场掐断这场对话。

如果不是（比如你在终端里），它只是个普通仓库，重启不影响你——但会打断**另一场**正在
进行的对话，动手前值得问一句。

## 源码在哪

不要猜路径。这个 skill 一般是从仓库软链到 skills 目录的，解析它自身所在目录的软链就能
拿到仓库根；桥接装出来的命令行工具同理，也是指回源码的软链。

## 要查 QQ 的接口时

有官方文档，别靠猜也别以为没有。入口、检索要点和已知的缺漏（包括几个文档里没有、但实际会
收到的错误码）都记在仓库 README 的「QQ 的接口文档」一节。

## 改完之后

编辑源码不影响已经跑起来的进程，必须重启。怎么重启取决于它是怎么托管的——读仓库里
进程托管相关的脚本，照它的方式来，别假设某种 init 系统。

**如果你就是那个会话，重启等于自杀**：

1. 先把话说完——改了什么、怎么回滚。重启之后就没机会讲了
2. 排程重启的命令必须是**整个 turn 的最后一个工具调用**，之后不再输出任何文字
3. 延迟给十几秒即可。流式发送与生成是并行的，排程那一刻只剩一小截尾巴没发完

会话本身不会丢：session id 落在磁盘上，进程起来会 resume，上下文接得回来。

**别拿重启当验证手段。** 能在本地跑通的先跑通，重启只用来确认最终效果——每一次重启都
要打断一场对话。

改什么、怎么改，读源码自己定：每个文件开头都写了自己的职责，比任何转述都新。
