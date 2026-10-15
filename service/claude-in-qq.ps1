#
# Task Scheduler entry point — the Windows counterpart of claude-in-qq.sh.
#
# Task Scheduler cannot set environment variables, so the proxy comes in as
# parameters baked into the task's arguments by install.ps1. The rest is what
# the shell version does: bail out if a bridge is alive, rotate logs, roll the
# repo back after repeated start-up crashes, run bun.

param(
  [string]$Proxy = '',
  [string]$NoProxy = ''
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path $PSScriptRoot
$StateDir = if ($env:QQ_STATE_DIR) { $env:QQ_STATE_DIR } else { Join-Path $HOME '.claude\channels\qq' }
$MaxBytes = 5MB # one generation kept

# The task fires every minute, so most invocations find a healthy bridge and
# have nothing to do. Only when one is missing does the timer become a restart.
$running = Get-CimInstance Win32_Process -Filter "Name = 'bun.exe'" |
  Where-Object { $_.CommandLine -like '*src/index.ts*' }
if ($running) { exit 0 }

New-Item -ItemType Directory -Force $StateDir | Out-Null
foreach ($name in 'bridge.log', 'service.log') {
  $file = Join-Path $StateDir $name
  if ((Test-Path $file) -and (Get-Item $file).Length -ge $MaxBytes) {
    Move-Item -Force $file "$file.1"
  }
}

# Crash rollback; see claude-in-qq.sh for the scheme. Native commands do not
# throw under ErrorActionPreference, so every git call checks $LASTEXITCODE.
$CrashFile = Join-Path $StateDir 'crash-count'
$GoodFile = Join-Path $StateDir 'last-good-commit'
$CrashLimit = 3
$Utf8 = New-Object System.Text.UTF8Encoding $false

function Invoke-Rollback([string]$Good) {
  $head = (git -C $Root rev-parse HEAD); if ($LASTEXITCODE) { return $false }
  if ($head -eq $Good) { return $false }
  git -C $Root cat-file -e "$Good^{commit}" 2>$null; if ($LASTEXITCODE) { return $false }
  $from = (git -C $Root symbolic-ref --short -q HEAD); if (-not $from) { $from = 'detached' }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stash = '（工作区干净，未 stash）'
  if (git -C $Root status --porcelain) {
    git -C $Root stash push -u -m "claude-in-qq auto-rollback $stamp" | Out-Null
    if ($LASTEXITCODE) { return $false }
    $stash = "``claude-in-qq auto-rollback $stamp``"
  }
  $lockBefore = (git -C $Root rev-parse 'HEAD:bun.lock' 2>$null)
  git -C $Root checkout -q --detach $Good; if ($LASTEXITCODE) { return $false }
  $lockAfter = (git -C $Root rev-parse 'HEAD:bun.lock' 2>$null)
  if ($lockBefore -ne $lockAfter) {
    Push-Location $Root
    try { & "$HOME\.bun\bin\bun.exe" install --frozen-lockfile | Out-Null } catch {} finally { Pop-Location }
  }
  $log = Join-Path $StateDir 'service.log'
  $tail = if (Test-Path $log) { (Get-Content $log -Tail 30 -Encoding utf8) -join "`n" } else { '' }
  $fence = '```'
  $note = @"

## 崩溃自动回滚

bridge 连续 $CrashLimit 次启动后没能稳定运行 60 秒，启动脚本已把仓库回滚到最后一个好版本。

- 原来：``$from`` @ ``$($head.Substring(0, 7))``
- 现在：detached @ ``$($Good.Substring(0, 7))``（分支和坏提交都没动，修好后 ``git checkout $from`` 即可回去）
- 工作区：$stash

``service.log`` 最后 30 行：

$fence
$tail
$fence

先向操作者说明发生了什么，再排查崩溃原因。

"@
  [IO.File]::AppendAllText((Join-Path $StateDir 'wake.md'), $note, $Utf8)
  return $true
}

$count = 0
# Wrapped in "$(...)": -Raw returns $null for an empty file, and .Trim() on
# $null throws, which under 'Stop' would keep the bridge from starting at all.
if (Test-Path $CrashFile) { [int]::TryParse("$(Get-Content $CrashFile -Raw)".Trim(), [ref]$count) | Out-Null }
$good = if (Test-Path $GoodFile) { "$(Get-Content $GoodFile -Raw)".Trim() } else { '' }
if ($count -ge $CrashLimit -and $good) {
  if (Invoke-Rollback $good) { $count = 0 }
}
[IO.File]::WriteAllText($CrashFile, "$($count + 1)`n", $Utf8)

if ($Proxy) {
  $env:HTTP_PROXY = $Proxy
  $env:HTTPS_PROXY = $Proxy
}
if ($NoProxy) { $env:NO_PROXY = $NoProxy }

# bun writes UTF-8, but pwsh decodes a native command's output with the
# console code page (GBK on a Chinese system) before appending it to the log.
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Set-Location $Root
# Tells /restart that exiting is safe: the task's one-minute watchdog starts the next one.
$env:CLAUDE_IN_QQ_SUPERVISOR = 'schtasks'
& "$HOME\.bun\bin\bun.exe" run src/index.ts *>> (Join-Path $StateDir 'service.log')
