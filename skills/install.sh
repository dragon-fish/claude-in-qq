#!/bin/sh
#
# Make this repo's skills reachable from any Claude Code session on this
# machine, plus the qq-notify command itself:
#
#   ~/.local/bin/qq-notify        the command
#   ~/.claude/skills/<name>       one symlink per directory under skills/
#
# All of them are symlinks into this repo, so editing the source is enough —
# there is no second copy to keep in sync. Adding a skill means adding a
# directory here; this script needs no edit. Independent of service/install.sh:
# neither notifications nor skills require running the bridge as a service.
#
#   skills/install.sh             install / repair
#   skills/install.sh --uninstall remove the links

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
BIN="$HOME/.local/bin/qq-notify"
SKILL_DIR="$HOME/.claude/skills"

# Every directory under skills/ is a skill. Printed one per line so the loops
# below stay readable when a name ever contains something surprising.
skills() {
  for d in "$ROOT"/skills/*/; do
    [ -d "$d" ] || continue
    basename "$d"
  done
}

if [ "${1:-}" = "--uninstall" ]; then
  for link in "$BIN" $(skills | sed "s|^|$SKILL_DIR/|"); do
    if [ -L "$link" ]; then
      rm "$link"
      echo "已移除 $link"
    fi
  done
  exit 0
fi

# Refuse to clobber a real file or someone else's skill of the same name.
for link in "$BIN" $(skills | sed "s|^|$SKILL_DIR/|"); do
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    echo "! $link 已存在且不是软链，先自行处理" >&2
    exit 1
  fi
done

mkdir -p "$HOME/.local/bin" "$SKILL_DIR"
chmod +x "$ROOT/src/notify.ts"
ln -sfn "$ROOT/src/notify.ts" "$BIN"

echo "已安装:"
echo "  $BIN -> $ROOT/src/notify.ts"
for name in $(skills); do
  ln -sfn "$ROOT/skills/$name" "$SKILL_DIR/$name"
  echo "  $SKILL_DIR/$name -> $ROOT/skills/$name"
done

case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "! ~/.local/bin 不在 PATH 里，qq-notify 需要写全路径才能调用" ;;
esac
