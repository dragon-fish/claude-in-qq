/**
 * Paths typed by the operator (/cwd) or written by the agent (MEDIA lines),
 * turned into the one spelling the filesystem uses.
 *
 * On Windows the same directory has many spellings — `e:/x`, `E:\X`, and the
 * Git Bash `/e/x` the agent picks up from its own shell — and whichever one
 * comes in gets shown back, persisted, and handed to the SDK as the cwd.
 */

import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const IS_WINDOWS = process.platform === 'win32'

/** Git Bash / MSYS drive paths: `/e/foo` is `E:\foo`. */
const MSYS_DRIVE_RE = /^\/([a-zA-Z])(?:\/|$)/

/**
 * Relative paths resolve against `base`. A path that does not exist comes back
 * resolved but otherwise untouched, so the caller's own error names it.
 */
export function nativePath(input: string, base: string): string {
  let p = input.startsWith('~') ? join(homedir(), input.slice(1)) : input
  // The slash stays: a bare `e:` means that drive's current directory, not its root.
  if (IS_WINDOWS) p = p.replace(MSYS_DRIVE_RE, '$1:/')
  p = resolve(base, p)
  // Only Windows needs the real spelling: its filesystem ignores case, so the
  // name typed is not the name stored. Elsewhere realpath would also follow
  // symlinks, swapping the path the operator chose for its target.
  return IS_WINDOWS && existsSync(p) ? realpathSync.native(p) : p
}
