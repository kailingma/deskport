# Installs deskport-agent for the current Windows user and joins this machine to a hub.
#
#   irm https://<hub>/agent/v1/install.ps1 | iex                  (asks for the join token)
#   $env:DESKPORT_JOIN_TOKEN='<join token>'; irm https://<hub>/agent/v1/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://<hub>/agent/v1/install.ps1))) <join token> [-Name <name>]
#   powershell -ExecutionPolicy Bypass -File scripts\install-agent.ps1 <hub> <join token> [-Name <name>] [-Binary <path>]
#
# The hub fills in its own address when it serves this script, so the hub
# argument is only needed from a checkout.
#
# Puts the binary in %LOCALAPPDATA%\Programs\deskport-agent, joins the hub (the
# settings go to %APPDATA%\deskport-agent), and registers the scheduled task
# deskport-agent, which starts it at each logon in this user's session, with
# no window. Without -Binary it downloads the build from the hub, which needs
# the join token, so mint a fresh one in the hub first. Needs Windows 10 1809
# or later and no administrator rights.
param(
  [Parameter(Position = 0)][string]$Hub = '',
  [Parameter(Position = 1)][string]$Token = '',
  [string]$Name = '',
  [string]$Binary = ''
)
# Replaced by the hub when it serves this file (hub/server.js).
$ServedBy = '__DESKPORT_HUB__'
# One positional argument from the hub's one-liner is the token.
if ($Hub -and $Hub -notmatch '^https?://' -and -not $Token) { $Token = $Hub; $Hub = '' }
if (-not $Hub -and -not $ServedBy.StartsWith('__')) { $Hub = $ServedBy }
if (-not $Hub) { throw 'No hub address; pass it first, e.g. install-agent.ps1 https://desk.example.com <join token>' }
if (-not $Token) { $Token = $env:DESKPORT_JOIN_TOKEN }
if (-not $Token) { $Token = (Read-Host 'Join token (Machines, Add machine in the hub)').Trim() }
if (-not $Token) { throw 'No join token; set $env:DESKPORT_JOIN_TOKEN or pass it as an argument.' }
$ErrorActionPreference = 'Stop'
# Invoke-WebRequest is many times slower with its progress bar.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$Hub = $Hub.TrimEnd('/')
$TaskName = 'deskport-agent'

$build = [Environment]::OSVersion.Version.Build
if ($build -lt 17763) { throw "deskport-agent needs Windows 10 version 1809 (build 17763) or later; this is build $build." }
# There is no Arm build yet; Windows 11 on Arm runs the x86_64 one.
if (@('AMD64', 'ARM64') -notcontains $env:PROCESSOR_ARCHITECTURE) { throw "No deskport-agent build for $($env:PROCESSOR_ARCHITECTURE)." }
$Platform = 'windows-x86_64'

$Dir = Join-Path $env:LOCALAPPDATA 'Programs\deskport-agent'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Exe = Join-Path $Dir 'deskport-agent.exe'
$Tmp = Join-Path $Dir 'deskport-agent.download'

if ($Binary) {
  Copy-Item -LiteralPath $Binary -Destination $Tmp -Force
} else {
  Write-Host "downloading deskport-agent for $Platform from $Hub"
  Invoke-WebRequest -UseBasicParsing -Headers @{ Authorization = "Bearer $Token" } -Uri "$Hub/agent/v1/download/$Platform" -OutFile $Tmp
}

# Stop an agent installed before; its file is in use while it runs.
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-Process -Name 'deskport-agent' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $Exe) {
  # Windows lets a running program be renamed, not replaced; the agent deletes these later.
  $stamp = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  Move-Item -LiteralPath $Exe -Destination (Join-Path $Dir "deskport-agent.$stamp.old") -Force
}
Move-Item -LiteralPath $Tmp -Destination $Exe -Force
Write-Host "installed $Exe ($(& $Exe version))"

$joinArgs = @('join', $Hub, $Token)
if ($Name) { $joinArgs += @('--name', $Name) }
& $Exe @joinArgs
if ($LASTEXITCODE -ne 0) { throw "deskport-agent join failed (exit status $LASTEXITCODE)." }

# conhost --headless gives the agent a console without a window (the agent
# is a console program, and Task Scheduler would otherwise show one).
$Conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$RunArgs = "--headless `"$Exe`" service"
$User = "$env:USERDOMAIN\$env:USERNAME"
try {
  $action = New-ScheduledTaskAction -Execute $Conhost -Argument $RunArgs -WorkingDirectory $Dir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
  $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
  # No time limit (the default stops a task after 3 days), and keep running on battery.
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'deskport agent (this machine in a deskport hub)' -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "started the scheduled task $TaskName; it starts the agent at each logon"
} catch {
  $why = $_.Exception.Message
  $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) "$TaskName.lnk"
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  $shortcut.TargetPath = $Conhost
  $shortcut.Arguments = $RunArgs
  $shortcut.WorkingDirectory = $Dir
  $shortcut.WindowStyle = 7
  $shortcut.Save()
  Start-Process -FilePath $Conhost -ArgumentList $RunArgs -WorkingDirectory $Dir -WindowStyle Hidden
  Write-Host "Could not make a scheduled task ($why). Added $lnk instead, which starts the agent at each logon, and started it."
}
Write-Host "The agent's log is $(Join-Path $env:LOCALAPPDATA 'deskport-agent\agent.log'). To remove it: & `"$Exe`" uninstall"
