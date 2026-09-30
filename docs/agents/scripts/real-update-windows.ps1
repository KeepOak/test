# The real update test on Windows (Legion): install the release before the newest one with its own
# one-step installer, put real work in it, press its own Update button, and check what is left.
# Everything lives under C:\ru (install, data, temp, Start menu, a throwaway registry key); the
# signed-in person's own Branch Agent, data and shortcuts are never used.
#
# The app needs a real desktop, so run scenarios through the desktop bridge, from the repository:
#   powershell -NoProfile -File docs/agents/scripts/desktop-bridge.ps1 -Wait -Run 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\ru\driver\real-update-windows.ps1 run normal'
#
#   real-update-windows.ps1 setup <from-tag> <to-tag>   downloads both releases, installs the driver
#   real-update-windows.ps1 run <scenario>              normal | corrupt | drop | kill-switch | installer | installer-open
#   real-update-windows.ps1 clean                       stops everything, removes C:\ru and the test key
param([string]$Command, [string]$A, [string]$B)
$ErrorActionPreference = 'Continue'
$RU = 'C:\ru'; $W = "$RU\w"; $Repo = 'stabrea/Branch-Agent'; $Asset = 'Branch-Agent-windows-x64.zip'
$Install = "$W\Programs\Branch Agent"; $Exe = "$Install\Branch Agent.exe"
$Data = "$W\userdata\state"; $Scratch = "$W\tmp\branch-agent-update"; $D = "$RU\driver\real-update-test.mjs"
$Hive = 'HKCU\Software\BranchRealUpdateTest'
$env:BRANCH_DESKTOP_HOME = "$W\userdata"
$env:TEMP = "$W\tmp"; $env:TMP = "$W\tmp"; $env:APPDATA = "$W\AppData\Roaming"; $env:LOCALAPPDATA = "$W\AppData\Local"
function Say($line) { Write-Output "== $line" }
function Drive { & node.exe $D @args 2>&1 | Where-Object { $_ -notmatch ' MB of ' } | ForEach-Object { "$_" } }

function Setup($from, $to) {
  foreach ($pair in @(@('from', $from), @('to', $to))) {
    $dir = "$RU\dl\$($pair[0])"; New-Item -ItemType Directory -Force $dir | Out-Null
    foreach ($f in @($Asset, "$Asset.sha256", 'Install.Branch.Agent.cmd')) {
      & curl.exe -fsSL -o "$dir\$f" "https://github.com/$Repo/releases/download/$($pair[1])/$f"
    }
    $want = ((Get-Content "$dir\$Asset.sha256" -Raw).Trim() -split '\s+')[0].ToLower()
    $got = (Get-FileHash "$dir\$Asset" -Algorithm SHA256).Hash.ToLower()
    if ($want -ne $got) { Write-Output "FAIL: $($pair[1]) download does not match its checksum"; exit 1 }
  }
  New-Item -ItemType Directory -Force "$RU\driver" | Out-Null
  Copy-Item "$PSScriptRoot\real-update-test.mjs", "$PSScriptRoot\drop-connection.ps1" "$RU\driver\" -ErrorAction SilentlyContinue
  Push-Location "$RU\driver"; & npm init -y | Out-Null; & npm i playwright-core@1 2>&1 | Out-Null; Pop-Location
}

# Everything started from the test folders, and nothing else.
function StopAll {
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "$W\*" -or $_.CommandLine -like "*$W\tmp\branch-agent-update*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep 3
}

# The one-step installer, as a person runs it, told to install into the test folders.
function RunInstaller($which) {
  $flags = "--install-root `"$Install`" --start-menu `"$W\StartMenu`" --desktop `"$W\Desktop`" --uninstall-hive `"$Hive`" --user-data `"$W\userdata`""
  Say "running the $which one-step installer"
  # Through a small batch file: cmd.exe's quoting survives that, and `echo.|` answers its closing "press a key".
  Set-Content "$RU\run-installer.cmd" "@echo off`r`necho.| `"$RU\dl\$which\Install.Branch.Agent.cmd`" $flags`r`nexit /b %ERRORLEVEL%" -Encoding Ascii
  cmd.exe /d /c "$RU\run-installer.cmd" 2>&1 | ForEach-Object { "  $_" }
  "  installer exit code: $LASTEXITCODE"
}

function Fresh {
  StopAll; Remove-Item -Recurse -Force $W -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force "$W\tmp", "$W\AppData\Roaming", "$W\AppData\Local" | Out-Null
  RunInstaller 'from'
  Drive launch --exe $Exe --port 9391
  Drive plant --data $Data --out "$RU\planted.json"
}

function Leftovers {
  Say 'on disk'
  Get-ChildItem "$W\Programs" | ForEach-Object { "  $($_.Name): " + ((Get-Content "$($_.FullName)\resources\app\package.json" -ErrorAction SilentlyContinue | Select-String '"version"') -replace '\s+', ' ') }
  Get-ChildItem "$W\StartMenu", "$W\Desktop" -ErrorAction SilentlyContinue | ForEach-Object { "  shortcut: $($_.FullName)" }
  if (Test-Path $Scratch) { '  temp left: {0:N0} MB' -f ((Get-ChildItem $Scratch -Recurse -File | Measure-Object Length -Sum).Sum / 1MB) }
  Get-Content "$Scratch\apply-update.log" -ErrorAction SilentlyContinue | ForEach-Object { "  log: $_" }
}

function Again($expect) {
  Say "starting it again, the way a person would after a restart"
  StopAll
  if (-not (Test-Path $Exe)) { Write-Output "FAIL: there is no program at $Exe to start"; return }
  Drive launch --exe $Exe --port 9391
  Drive verify --data $Data --planted "$RU\planted.json" --expect $expect
}

$from = if ($env:FROM_VERSION) { $env:FROM_VERSION } else { '0.17.0' }
$to = if ($env:TO_VERSION) { $env:TO_VERSION } else { '0.18.0' }
switch ($Command) {
  'setup' { Setup $A $B }
  'run' {
    Say "scenario $A"
    switch ($A) {
      'normal' { Fresh; Drive update --port 9391 --scratch $Scratch; Start-Sleep 30
        Drive verify --data $Data --planted "$RU\planted.json" --expect $to; Leftovers; Again $to }
      'corrupt' { Fresh; Drive update --port 9391 --scratch $Scratch --fault corrupt; Leftovers; Again $from }
      'drop' { Fresh; Drive update --port 9391 --scratch $Scratch --fault drop --drop-cmd "powershell -NoProfile -ExecutionPolicy Bypass -File $RU\driver\drop-connection.ps1 -Under `"$W`""
        Leftovers; Again $from }
      'kill-switch' { Fresh; Drive update --port 9391 --scratch $Scratch --fault kill-switch; Start-Sleep 5; Leftovers; Again $from }
      'installer' { Fresh; StopAll; RunInstaller 'to'; Leftovers; Again $to }
      # The owner's first real install of 0.18.0 was run with 0.17.0 still open, which is the usual case.
      'installer-open' { Fresh; RunInstaller 'to'; Leftovers; Again $to }
      default { Write-Output "unknown scenario $A" }
    }
    StopAll
  }
  'clean' { StopAll; Remove-Item -Recurse -Force $RU -ErrorAction SilentlyContinue; reg.exe delete $Hive /f 2>&1 | Out-Null; Say 'cleaned' }
  default { Write-Output 'usage: real-update-windows.ps1 setup <from-tag> <to-tag> | run <scenario> | clean' }
}
