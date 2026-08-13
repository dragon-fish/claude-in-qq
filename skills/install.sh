#!/bin/sh
#
# Make `qq-notify` reachable from any Claude Code session on this machine:
#
#   ~/.local/bin/qq-notify        the command itself
#   ~/.claude/skills/qq-notify    the skill that teaches sessions to use it
#
# Both are symlinks into this repo, so editing the source is enough — there is
# no second copy to keep in sync. Independent of service/install.sh: sending
# notifications does not require running the bridge as a service.
#
#   skills/install.sh             install / repair
#   skills/install.sh --uninstall remove both links

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
BIN="$HOME/.local/bin/qq-notify"
SKILL="$HOME/.claude/skills/qq-notify"

if [ "${1:-}" = "--uninstall" ]; then
  for link in "$BIN" "$SKILL"; do
    if [ -L "$link" ]; then
      rm "$link"
      echo "已移除 $link"
    fi
  done
  exit 0
fi

# Refuse to clobber a real file or someone else's skill of the same name.
for link in "$BIN" "$SKILL"; do
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    echo "! $link 已存在且不是软链，先自行处理" >&2
    exit 1
  fi
done

mkdir -p "$HOME/.local/bin" "$HOME/.claude/skills"
chmod +x "$ROOT/src/notify.ts"
ln -sfn "$ROOT/src/notify.ts" "$BIN"
ln -sfn "$ROOT/skills/qq-notify" "$SKILL"

echo "已安装:"
echo "  $BIN -> $ROOT/src/notify.ts"
echo "  $SKILL -> $ROOT/skills/qq-notify"

case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "! ~/.local/bin 不在 PATH 里，qq-notify 需要写全路径才能调用" ;;
esac
