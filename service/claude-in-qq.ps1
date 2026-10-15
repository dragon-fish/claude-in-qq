#
# Task Scheduler entry point — the Windows counterpart of claude-in-qq.sh.
#
# Task Scheduler cannot set environment variables, so the proxy comes in as
# parameters baked into the task's arguments by install.ps1. The rest is what
# the shell version does: bail out if a bridge is alive, rotate logs, run bun.

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
