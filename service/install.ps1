#
# Install or reload the bridge as a Task Scheduler task — the Windows
# counterpart of install.sh. Idempotent; run it again after editing it.
#
#   pwsh service/install.ps1                     install / reload
#   Unregister-ScheduledTask claude-in-qq        uninstall (then stop bun, see below)
#
# Stopping the task does not stop the bridge: Task Scheduler ends the launcher
# but leaves bun running. To restart or stop, end bun itself —
#
#   Get-CimInstance Win32_Process -Filter "Name = 'bun.exe'" |
#     Where-Object CommandLine -like '*src/index.ts*' |
#     ForEach-Object { Stop-Process -Id $_.ProcessId }
#
# — and the watchdog trigger brings it back within a minute unless the task
# was unregistered first.
#
# The proxy is read from this shell and baked into the task's arguments, so
# run this from the shell you actually use. PATH is not passed: unlike launchd,
# Task Scheduler builds it from the registry, which is the real one — only
# entries a $PROFILE adds on the fly are missing.

$ErrorActionPreference = 'Stop'

$TaskName = 'claude-in-qq'
$Launcher = Join-Path $PSScriptRoot 'claude-in-qq.ps1'
$LogDir = if ($env:QQ_STATE_DIR) { $env:QQ_STATE_DIR } else { Join-Path $HOME '.claude\channels\qq' }

# Unregister first, so the watchdog cannot relaunch a bridge while the check
# below asks you to stop it. Two bridges hold the same gateway session and
# fight over it — messages land in whichever won the last reconnect.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$running = Get-CimInstance Win32_Process -Filter "Name = 'bun.exe'" |
  Where-Object { $_.CommandLine -like '*src/index.ts*' }
if ($running) {
  Write-Host '! 有 bridge 在跑（手动启动的，或上一次安装留下的），先停掉它再重跑本脚本：'
  $running | ForEach-Object { Write-Host "  $($_.ProcessId)  $($_.CommandLine)" }
  Write-Host "  Stop-Process -Id $(($running.ProcessId) -join ',')"
  exit 1
}

$Proxy = @($env:HTTPS_PROXY, $env:https_proxy) | Where-Object { $_ } | Select-Object -First 1
$NoProxy = @($env:NO_PROXY, $env:no_proxy) | Where-Object { $_ } | Select-Object -First 1
if (-not $Proxy) {
  Write-Host '! 环境里没有 HTTPS_PROXY，生成的服务会直连。'
  Write-Host '  若 api.anthropic.com 在本地需要代理，请先设好变量再重跑本脚本。'
}

$pwsh = (Get-Process -Id $PID).Path
$launcherArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$Launcher`""
if ($Proxy) { $launcherArgs += " -Proxy `"$Proxy`"" }
if ($NoProxy) { $launcherArgs += " -NoProxy `"$NoProxy`"" }

# conhost --headless gives pwsh a console that is never shown. Without it every
# launch — once a minute, see below — flashes a terminal window, and
# -WindowStyle Hidden only shortens the flash.
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$pwsh`" $launcherArgs"

# Two triggers, because a repetition attached to the logon trigger only starts
# counting at the next logon — installing it while logged in leaves the
# watchdog dead until a reboot. The time trigger repeats from now, forever.
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(5) -RepetitionInterval (New-TimeSpan -Minutes 1)

# ExecutionTimeLimit defaults to 72 hours, after which the task is killed.
# IgnoreNew keeps the minutely watchdog from stacking launchers while one waits on bun.
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $atLogon, $watchdog `
  -Settings $settings -Principal $principal -Description "claude-in-qq bridge ($Launcher)" | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep 5
Write-Host "已安装计划任务 $TaskName"
Get-CimInstance Win32_Process -Filter "Name = 'bun.exe'" |
  Where-Object { $_.CommandLine -like '*src/index.ts*' } |
  ForEach-Object { Write-Host "  bun pid $($_.ProcessId)" }
Write-Host ''
Write-Host "日志: Get-Content -Wait $LogDir\bridge.log"
