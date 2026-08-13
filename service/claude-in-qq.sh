#!/bin/sh
#
# launchd entry point.
#
# Exists for one reason launchd cannot do itself: rotate the logs. launchd
# appends to StandardOutPath forever, and a bridge that crash-loops on bad
# credentials would fill the disk with the same stack trace. Rotating here
# means every restart is also a size check.
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

cd "$ROOT"
exec "$HOME/.bun/bin/bun" run src/index.ts
