# PCRemote installer: dependencies, optional controller support, password, Tailscale,
# the laptop certificate, firewall, and start at sign-in. Run it through install.bat
# (asks for admin). Safe to run again to update or repair; the laptop certificate is kept.
# -Uninstall reverses the PCRemote parts (leaves Node, FFmpeg, Tailscale and drivers).
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$taskName = 'PCRemote'
$ruleName = 'PCRemote'
$cfgPath = Join-Path $root 'data\config.json'

function Stop-PCRemote {
  foreach ($name in 'wscript.exe', 'node.exe') {
    Get-CimInstance Win32_Process -Filter "Name='$name'" |
      Where-Object { $_.CommandLine -and $_.CommandLine -like "*$root*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
}
function Read-Config { if (Test-Path $cfgPath) { try { Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $null } } }
function TailscaleExe {
  @("$env:ProgramFiles\Tailscale\tailscale.exe", "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
}

if ($Uninstall) {
  Stop-PCRemote
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  Write-Host 'PCRemote stopped and removed from startup and the firewall. Files, settings and Tailscale were kept.' -ForegroundColor Green
  return
}

Write-Host '== PCRemote setup ==' -ForegroundColor Cyan

# 1. Node.js and packages
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing Node.js (LTS)...' -ForegroundColor Yellow
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js could not be installed automatically. Install the LTS version from https://nodejs.org and run install.bat again.' }
}
if (-not (Test-Path (Join-Path $root 'node_modules\ws'))) {
  Write-Host 'Installing packages...'
  npm ci --omit=dev --no-fund --no-audit
  if ($LASTEXITCODE) { throw 'npm ci failed' }
}

# 2. FFmpeg (GPU screen capture + NVENC encoder)
$ff = Join-Path $root 'bin\ffmpeg.exe'
if (-not (Test-Path $ff)) {
  Write-Host 'Downloading FFmpeg (~110 MB)...'
  $tmp = Join-Path $env:TEMP ('pcremote-ffmpeg-' + [guid]::NewGuid())
  New-Item -ItemType Directory $tmp | Out-Null
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile "$tmp\ff.zip" -UseBasicParsing
  Expand-Archive "$tmp\ff.zip" -DestinationPath "$tmp\x"
  New-Item -ItemType Directory -Force (Join-Path $root 'bin') | Out-Null
  Copy-Item (Get-ChildItem "$tmp\x" -Recurse -Filter ffmpeg.exe | Select-Object -First 1).FullName $ff
  Remove-Item $tmp -Recurse -Force
}

# 2b. Optional: game controllers. A gamepad plugged into the laptop shows up on
#     the PC as an Xbox 360 controller (needs the ViGEmBus driver).
$gpExe = Join-Path $root 'bin\gamepad.exe'
function Test-ViGEmBus { [bool](Get-PnpDevice -FriendlyName '*Virtual Gamepad Emulation Bus*' -ErrorAction SilentlyContinue) }
if (-not (Test-ViGEmBus)) {
  Write-Host ''
  $answer = Read-Host 'Enable game controller support? This installs the ViGEmBus driver. [y/N]'
  if ($answer -match '^(y|yes)$') {
    winget install --id ViGEm.ViGEmBus -e --silent --accept-package-agreements --accept-source-agreements
    if (-not (Test-ViGEmBus)) { Write-Warning 'The ViGEmBus driver did not finish installing. Restart the PC and run install.bat again.' }
  }
}
if ((Test-ViGEmBus) -and -not (Test-Path $gpExe)) {
  Write-Host 'Building the game controller helper...'
  $vigemDll = Join-Path $root 'bin\Nefarius.ViGEm.Client.dll'
  if (-not (Test-Path $vigemDll)) {
    # Pinned version, verified by hash before use.
    $tmp = Join-Path $env:TEMP ('pcremote-vigem-' + [guid]::NewGuid())
    New-Item -ItemType Directory $tmp | Out-Null
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest 'https://www.nuget.org/api/v2/package/Nefarius.ViGEm.Client/1.21.256' -OutFile "$tmp\pkg.zip" -UseBasicParsing
    Expand-Archive "$tmp\pkg.zip" -DestinationPath "$tmp\x"
    $src = Join-Path $tmp 'x\lib\netstandard2.0\Nefarius.ViGEm.Client.dll'
    if ((Get-FileHash $src -Algorithm SHA256).Hash -ne '4458301000B732D115521E99F9936F4EDB70D6CEB3036EF158715E0E6B8902E0') {
      Remove-Item $tmp -Recurse -Force
      throw 'Nefarius.ViGEm.Client.dll failed its checksum check; not using it.'
    }
    New-Item -ItemType Directory -Force (Join-Path $root 'bin') | Out-Null
    Copy-Item $src $vigemDll
    Remove-Item $tmp -Recurse -Force
  }
  $fw = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
  & "$fw\csc.exe" /nologo /optimize /target:exe "/out:$gpExe" "/r:$fw\netstandard.dll" "/r:$vigemDll" (Join-Path $root 'lib\gamepad.cs')
  if ($LASTEXITCODE) { Write-Warning 'Could not build the game controller helper; controllers will not work.' }
}

# 3. Password (asked once)
Stop-PCRemote
$cfg = Read-Config
if (-not ($cfg -and $cfg.password)) {
  Write-Host ''
  Write-Host 'Choose the password for the first login on the laptop:' -ForegroundColor Yellow
  node server.js --set-password
  if ($LASTEXITCODE) { throw 'Password was not set.' }
}

# 4. Tailscale: lets the laptop reach the PC from any network, fully encrypted,
#    without opening anything to the internet.
$ts = TailscaleExe
if (-not $ts) {
  Write-Host ''
  Write-Host 'Installing Tailscale...' -ForegroundColor Yellow
  # Tailscale's installer fails with error 1603 while the IP Helper service is disabled.
  $iph = Get-Service iphlpsvc -ErrorAction SilentlyContinue
  if ($iph -and $iph.StartType -eq 'Disabled') { Set-Service iphlpsvc -StartupType Automatic; Start-Service iphlpsvc }
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id Tailscale.Tailscale -e --silent --accept-package-agreements --accept-source-agreements
  }
  $ts = TailscaleExe
  if (-not $ts) {
    Write-Warning 'Could not install Tailscale automatically. Install it from https://tailscale.com/download/windows, then run install.bat again.'
  }
}
if ($ts) {
  $tsIp = (& $ts ip -4 2>$null | Select-Object -First 1)
  if (-not $tsIp) {
    Write-Host 'Signing in to Tailscale (a browser window will open; sign in with your account)...' -ForegroundColor Yellow
    Start-Process $ts -ArgumentList 'up' -Wait
    Write-Host 'Waiting for Tailscale to connect...'
    for ($i = 0; $i -lt 30 -and -not $tsIp; $i++) { Start-Sleep 2; $tsIp = (& $ts ip -4 2>$null | Select-Object -First 1) }
  }
  if ($tsIp) { Write-Host "Tailscale is up. This PC's Tailscale address: $tsIp" -ForegroundColor Green }
  else { Write-Warning 'Tailscale is installed but not connected yet. Open the Tailscale app and sign in; PCRemote will pick it up automatically.' }
}

# 5. Bind only to Tailscale (the port then does not exist on the LAN or internet),
#    and issue THIS laptop's certificate (only it can connect afterwards).
#    Without Tailscale the PC would be unreachable, so it stays on the home network instead.
$bindMode = if ($ts) { 'tailscale' } else { 'lan' }
if (-not $ts) { Write-Warning 'Tailscale is missing, so access stays on the home network for now. Fix Tailscale and run install.bat again to switch to Tailscale-only.' }
node -e "const f='./data/config.json';const c=JSON.parse(require('fs').readFileSync(f,'utf8').replace(/^\uFEFF/,''));c.bind=process.argv[1];c.allowLan=process.argv[1]!=='tailscale';require('fs').writeFileSync(f,JSON.stringify(c,null,2))" $bindMode
node server.js --enroll
if ($LASTEXITCODE) { throw 'Certificate enrollment failed.' }
$cfg = Read-Config
$port = if ($cfg -and $cfg.port) { [int]$cfg.port } else { 9443 }

# 6. Firewall: allow PCRemote's port only from the Tailscale range (and the local
#    subnet only if LAN access was explicitly enabled).
$remote = @('100.64.0.0/10')
if ($cfg.allowLan) { $remote += 'LocalSubnet' }
$nodeExe = (Get-Command node).Source
Get-NetFirewallApplicationFilter |
  Where-Object { $_.Program -and [Environment]::ExpandEnvironmentVariables($_.Program) -ieq $nodeExe } |
  Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' } |
  ForEach-Object { Write-Host "Removing broad firewall rule for node.exe: $($_.DisplayName) ($($_.Action))"; Remove-NetFirewallRule -Name $_.Name }
Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $ruleName -Description 'PCRemote remote desktop (Tailscale only)' -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort $port -Profile Any -RemoteAddress $remote | Out-Null

# 7. Start at sign-in, elevated so admin windows (Task Manager, installers) work too.
$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$root\start-hidden.vbs`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

# 8. Start now
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3

# 9. Show the laptop setup
$enroll = Join-Path $root 'data\enroll'
Write-Host ''
Write-Host '====================  LAPTOP SETUP  ====================' -ForegroundColor Cyan
Write-Host 'A folder opened with this laptop''s certificate. On the LAPTOP:' -ForegroundColor Green
Write-Host '  1. Copy the whole folder over (USB, or:  tailscale file cp)'
Write-Host '  2. Run  install-on-laptop.bat  (click Yes if Windows asks)'
Write-Host '  3. Close all Chrome/Edge windows, reopen, and go to the address below.'
Write-Host ''
if ($ts) {
  $name = (& $ts status --json 2>$null | ConvertFrom-Json).Self.DNSName
  if ($name) { Write-Host ("  Open on the laptop:  https://{0}:{1}" -f $name.TrimEnd('.'), $port) -ForegroundColor Green }
  elseif ($tsIp) { Write-Host ("  Open on the laptop:  https://{0}:{1}" -f $tsIp, $port) -ForegroundColor Green }
}
Write-Host '========================================================' -ForegroundColor Cyan
Start-Process explorer.exe $enroll
