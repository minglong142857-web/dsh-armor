# Antigravity 破甲引擎启动器
# 起一个"自己的" language_server 实例：模型流量全部指向本地 relay，
# relay 在协议层重写 systemInstruction —— 云端护栏在这一层失效。
#
# 用法:
#   .\start-broken-ls.ps1                      # inject 模式，端口 8787
#   .\start-broken-ls.ps1 -Mode passthrough    # 对照组（等同原生）
#   .\start-broken-ls.ps1 -Mode replace -SystemFile .\system_override.txt
#   .\start-broken-ls.ps1 -Stop                # 关停本引擎

[CmdletBinding()]
param(
  [ValidateSet('passthrough','inject','replace')]
  [string]$Mode = 'inject',
  [int]$RelayPort = 8787,
  [string]$AppDataName = 'antigravity-broken',
  [string]$SystemFile = '',
  [switch]$SafetyNone,
  [switch]$Clone,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$Root      = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$GeminiDir = Join-Path $env:USERPROFILE '.gemini'
$AppRoot   = "$env:LOCALAPPDATA\Programs\antigravity"
$LsExe     = Join-Path $AppRoot 'resources\bin\language_server.exe'
$Python    = 'C:\Program Files\Python311\python.exe'
$RunDir    = Join-Path $Root 'run'
$LogDir    = Join-Path $Root 'logs'
$RelayLog  = Join-Path $LogDir "relay-$Mode.jsonl"
$CapDir    = Join-Path $LogDir "capture-$Mode"
$LsOut     = Join-Path $LogDir "ls-$Mode.out.log"
$LsErr     = Join-Path $LogDir "ls-$Mode.err.log"
$EnvFile   = Join-Path $RunDir 'broken.env'
$PidFile   = Join-Path $RunDir 'broken.pids.json'

New-Item -ItemType Directory -Force -Path $RunDir,$LogDir | Out-Null

# ---------------------------------------------------------------- 关停
if ($Stop) {
  if (Test-Path $PidFile) {
    $p = Get-Content $PidFile -Raw | ConvertFrom-Json
    foreach ($id in @($p.relay, $p.ls)) {
      if ($id) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    Write-Host "[stop] 已停止 relay/language_server 实例"
  } else {
    Write-Host "[stop] 无运行记录"
  }
  return
}

foreach ($p in @($LsExe,$Python)) { if (-not (Test-Path $p)) { throw "缺少: $p" } }

# ---------------------------------------------------------------- 1. 克隆 app data（隔离，不动主实例）
$AppData = Join-Path $GeminiDir $AppDataName
if (-not (Test-Path $AppData)) {
  Write-Host "[1/4] 克隆 app data -> $AppData (一次性，约 120MB)"
  Copy-Item (Join-Path $GeminiDir 'antigravity') $AppData -Recurse -Force -ErrorAction SilentlyContinue
} elseif ($Clone) {
  Write-Host "[1/4] 强制重新克隆"
  Remove-Item $AppData -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $GeminiDir 'antigravity') $AppData -Recurse -Force -ErrorAction SilentlyContinue
} else {
  Write-Host "[1/4] 复用已有 app data: $AppData"
}
New-Item -ItemType Directory -Force -Path (Join-Path $AppData 'daemon') | Out-Null

# ---------------------------------------------------------------- 2. 起 relay
Write-Host "[2/4] 启动 relay :$RelayPort mode=$Mode"
$relayArgs = @($Python, (Join-Path $Root 'relay\relay.py'),
  '--listen', "127.0.0.1:$RelayPort", '--mode', $Mode,
  '--log', $RelayLog, '--capture-dir', $CapDir)
if ($Mode -eq 'replace') { $relayArgs += @('--system-file', $SystemFile) }
if ($SafetyNone)          { $relayArgs += '--safety-none' }

$relay = Start-Process -FilePath $relayArgs[0] -ArgumentList $relayArgs[1..($relayArgs.Count-1)] `
         -PassThru -WindowStyle Hidden `
         -RedirectStandardOutput (Join-Path $LogDir "relay-$Mode.out.log") `
         -RedirectStandardError  (Join-Path $LogDir "relay-$Mode.err.log")
Start-Sleep -Milliseconds 900
if ($relay.HasExited) { throw "relay 启动失败，见 logs\relay-$Mode.err.log" }

# ---------------------------------------------------------------- 3. 起 language_server（指向 relay）
$csrf = [guid]::NewGuid().ToString()
Write-Host "[3/4] 启动 language_server (csrf=$csrf)"
$lsArgs = @(
  '--standalone',
  '--override_ide_name','antigravity',
  '--subclient_type','hub',
  '--override_ide_version','2.32.1',
  '--override_user_agent_name','antigravity',
  '--https_server_port','0',
  '--csrf_token',$csrf,
  '--app_data_dir',$AppDataName,
  '--enable_sidecars',
  '--api_server_url',"http://127.0.0.1:$RelayPort",
  '--cloud_code_endpoint',"http://127.0.0.1:$RelayPort",
  '--inference_api_server_url',"http://127.0.0.1:$RelayPort"
)
$ls = Start-Process -FilePath $LsExe -ArgumentList $lsArgs -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput $LsOut -RedirectStandardError $LsErr

# ---------------------------------------------------------------- 4. 等 hub 端口
$hub = $null
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 700
  $hubFile = Get-ChildItem (Join-Path $AppData 'daemon') -Filter 'hub_*.json' -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($hubFile) {
    $cand = Get-Content $hubFile.FullName -Raw | ConvertFrom-Json
    if ($cand.pid -eq $ls.Id) { $hub = $cand; break }
  }
  if ($ls.HasExited) { throw "language_server 退出 (code=$($ls.ExitCode))，见 $LsErr" }
}
if (-not $hub) { throw "90s 内未拿到 hub 端口，见 $LsErr" }

$envPs1 = Join-Path $RunDir 'broken.env.ps1'
$lines = @(
  "`$env:ANTIGRAVITY_LS_ADDRESS = 'http://127.0.0.1:$($hub.httpPort)'",
  "`$env:ANTIGRAVITY_CSRF_TOKEN = '$($hub.csrfToken)'",
  "Write-Host '[env] ANTIGRAVITY_LS_ADDRESS=$env:ANTIGRAVITY_LS_ADDRESS'"
)
Set-Content -Path $envPs1 -Value ($lines -join "`n") -Encoding UTF8
Set-Content -Path $EnvFile -Value @(
  "ANTIGRAVITY_LS_ADDRESS=http://127.0.0.1:$($hub.httpPort)",
  "ANTIGRAVITY_CSRF_TOKEN=$($hub.csrfToken)"
) -Encoding UTF8
@{ relay = $relay.Id; ls = $ls.Id; httpPort = $hub.httpPort; csrf = $hub.csrfToken; mode = $Mode } |
  ConvertTo-Json | Set-Content $PidFile -Encoding UTF8

Write-Host "[4/4] 就绪"
Write-Host "  app data : $AppData"
Write-Host "  relay    : http://127.0.0.1:$RelayPort  (mode=$Mode, 日志 $RelayLog)"
Write-Host "  ls 端口  : $($hub.httpPort)   pid=$($ls.Id)"
Write-Host "  env      : $EnvFile"
Write-Host ""
Write-Host "接入当前终端:  . `"$EnvFile`""
Write-Host "跑探针     :  .\probes\run_probes.ps1 -Mode $Mode -Label $Mode"
Write-Host "关停       :  .\bin\start-broken-ls.ps1 -Stop"
