#!/bin/sh
#
# launchd entry point.
#
# Exists for two things launchd cannot do itself. It rotates the logs: launchd
# appends to StandardOutPath forever, and a bridge that crash-loops on bad
# credentials would fill the disk with the same stack trace. And it rolls the
# repo back when new code keeps crashing at start, which KeepAlive would
# otherwise retry every ten seconds until someone reached the machine.
#
# Everything else is exec'd away, so bun — not this shell — is the process
# launchd supervises, and SIGTERM reaches the signal handlers in index.ts.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
STATE_DIR=${QQ_STATE_DIR:-$HOME/.claude/channels/qq}
MAX_BYTES=5242880 # 5 MiB, one generation kept

# launchd runs this on a timer, so most invocations find a healthy bridge and
# have nothing to do. Only when one is missing does the timer become a restart.
#
# The executable is read from `args` rather than `comm`, which macOS truncates —
# a bun under a long home path shows up as "/Users/name" and never matches. This
# script cannot match itself: its own argv[0] is /bin/sh.
if ps -axo pid=,args= | awk '$2 ~ /bun$/ && index($0, "src/index.ts")' | grep -q .; then
  exit 0
fi

# Written with `if` rather than `[ ... ] && return 0`: under `set -e` that form
# exits the whole script when the test fails, which here means the one case
# that matters — an oversized log — would stop the bridge from starting at all.
rotate() {
  file=$1
  if [ -f "$file" ]; then
    size=$(stat -f%z "$file" 2>/dev/null || echo 0)
    if [ "$size" -ge "$MAX_BYTES" ]; then
      mv -f "$file" "$file.1"
    fi
  fi
}

mkdir -p "$STATE_DIR"
rotate "$STATE_DIR/bridge.log"
rotate "$STATE_DIR/launchd.log"

# Crash rollback. Every launch adds one to crash-count; the bridge zeroes it once
# it has stayed up a minute (and writes last-good-commit) or when it stops on a
# signal. Three launches that never got there, on a commit other than the last
# good one, check that one out. Detached on purpose: the branch and the bad
# commits stay where they were, and the work tree is stashed rather than lost.
# The count restarts from zero afterwards, so a good commit that crashes too
# (a dead network, bad credentials) is retried, never rolled back again.
CRASH_FILE="$STATE_DIR/crash-count"
GOOD_FILE="$STATE_DIR/last-good-commit"
CRASH_LIMIT=3

# Every step checks its own status: called from an `if`, this function runs
# with `set -e` suspended, and a stash that failed must not go on to report a
# rollback that never happened.
rollback() {
  good=$1
  head=$(git -C "$ROOT" rev-parse HEAD) || return 1
  [ "$head" != "$good" ] || return 1
  git -C "$ROOT" cat-file -e "$good^{commit}" 2>/dev/null || return 1
  from=$(git -C "$ROOT" symbolic-ref --short -q HEAD || echo "detached")
  stamp=$(date +%Y%m%d-%H%M%S)
  stash="（工作区干净，未 stash）"
  if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
    git -C "$ROOT" stash push -u -m "claude-in-qq auto-rollback $stamp" >/dev/null || return 1
    stash="\`claude-in-qq auto-rollback $stamp\`"
  fi
  lock_before=$(git -C "$ROOT" rev-parse "HEAD:bun.lock" 2>/dev/null || true)
  git -C "$ROOT" checkout -q --detach "$good" || return 1
  lock_after=$(git -C "$ROOT" rev-parse "HEAD:bun.lock" 2>/dev/null || true)
  if [ "$lock_before" != "$lock_after" ]; then
    (cd "$ROOT" && "$HOME/.bun/bin/bun" install --frozen-lockfile) || true
  fi
  tail=$(tail -n 30 "$STATE_DIR/launchd.log" 2>/dev/null || true)
  cat >> "$STATE_DIR/wake.md" <<NOTE

## 崩溃自动回滚

bridge 连续 $CRASH_LIMIT 次启动后没能稳定运行 60 秒，启动脚本已把仓库回滚到最后一个好版本。

- 原来：\`$from\` @ \`$(echo "$head" | cut -c1-7)\`
- 现在：detached @ \`$(echo "$good" | cut -c1-7)\`（分支和坏提交都没动，修好后 \`git checkout $from\` 即可回去）
- 工作区：$stash

\`launchd.log\` 最后 30 行：

\`\`\`
$tail
\`\`\`

先向操作者说明发生了什么，再排查崩溃原因。
NOTE
  echo "$(date '+%Y-%m-%dT%H:%M:%S') rolled back $head -> $good" >&2
}

count=$(cat "$CRASH_FILE" 2>/dev/null || echo 0)
case $count in ''|*[!0-9]*) count=0 ;; esac
good=$(cat "$GOOD_FILE" 2>/dev/null || true)
if [ "$count" -ge "$CRASH_LIMIT" ] && [ -n "$good" ]; then
  # In an `if`, so a failed rollback is logged and the launch goes ahead
  # rather than `set -e` ending the script before the count is written.
  if rollback "$good"; then
    count=0
  else
    echo "$(date '+%Y-%m-%dT%H:%M:%S') rollback skipped or failed (head is last good, or git error)" >&2
  fi
fi
echo $((count + 1)) > "$CRASH_FILE"

cd "$ROOT"
# Tells /restart that exiting is safe: launchd's KeepAlive starts the next one.
export CLAUDE_IN_QQ_SUPERVISOR=launchd
exec "$HOME/.bun/bin/bun" run src/index.ts
