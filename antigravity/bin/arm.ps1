# 一键上甲：规则层 + 钩子层 + 协议层（language_server 垫片 + relay 改写/重试）
#   .\bin\arm.ps1                 # 全量上甲
#   .\bin\arm.ps1 -NoShim         # 只上规则+钩子（不动 language_server）
#   .\bin\arm.ps1 -Status         # 看当前状态
#   .\bin\disarm.ps1              # 全量回滚
[CmdletBinding()]
param(
  [switch]$NoShim,
  [switch]$Status,
  [ValidateSet('replace','inject','mitm')][string]$Mode = 'inject',
  [int]$Retries = 5,
  [int]$Port = 8787,
  [string]$Proxy = ''
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Bin  = "$env:LOCALAPPDATA\Programs\antigravity\resources\bin"
$Cfg  = Join-Path $env:USERPROFILE '.gemini\config'

if ($Status) {
  Write-Host "== 规则层 =="
  Write-Host ("  AGENTS.md      : " + (Test-Path (Join-Path $Cfg 'AGENTS.md')))
  Write-Host ("  hooks.json     : " + (Test-Path (Join-Path $Cfg 'hooks.json')))
  Write-Host ("  agy-hooks/     : " + (Test-Path (Join-Path $Cfg 'agy-hooks\override.txt')))
  Write-Host "== 协议层 =="
  $shim = Join-Path $Bin 'language_server.exe'
  $real = Join-Path $Bin 'language_server_real.exe'
  Write-Host ("  垫片已装       : " + ((Test-Path $real) -and ((Get-Item $shim).Length -lt 1MB)))
  Write-Host ("  原生备份       : " + (Test-Path $real))
  $lis = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  Write-Host ("  relay 监听 :$Port : " + [bool]$lis)
  if (Test-Path (Join-Path $Root 'run\relay.pid')) {
    Write-Host ("  relay pid      : " + (Get-Content (Join-Path $Root 'run\relay.pid')))
  }
  Write-Host "== 评测 =="
  Get-ChildItem (Join-Path $Root 'logs') -Directory -Filter 'runs' -ErrorAction SilentlyContinue | ForEach-Object {
    Get-ChildItem $_.FullName -Directory | Select-Object -Last 3 | ForEach-Object { Write-Host ("  run: " + $_.Name) }
  }
  return
}

# ---------------------------------------------------------------- 0. MITM 全自动模式
if ($Mode -eq 'mitm') {
  Write-Host "[0/3] MITM 模式：装 CA + 起中继(replace + v4 + claude + 剥包装) + 写代理变量"
  & (Join-Path $Root 'bin\mitm.ps1') -InstallCa | Out-Host
  & (Join-Path $Root 'bin\mitm.ps1') -Start | Out-Host
  & setx HTTPS_PROXY "http://127.0.0.1:8790" | Out-Null
  & setx HTTP_PROXY  "http://127.0.0.1:8790" | Out-Null
  & setx NO_PROXY    "127.0.0.1,localhost" | Out-Null
  Write-Host ""
  Write-Host "MITM 就绪。重启 Antigravity 后，GUI 里所有请求都会：模型重写 + 契约替换 + 剥包装 + 拒答换写重试"
  Write-Host "回滚：.\bin\mitm.ps1 -Disable"
  return
}

# ---------------------------------------------------------------- 1. 规则 + 钩子
Write-Host "[1/3] 规则层 + 钩子层"
& (Join-Path $Root 'install.ps1') | Out-Host

# ---------------------------------------------------------------- 2. 垫片
if (-not $NoShim) {
  Write-Host "`n[2/3] 协议层垫片"
  & (Join-Path $Root 'bin\shim.ps1') -Build | Out-Host
  & (Join-Path $Root 'bin\shim.ps1') -Install | Out-Host
} else {
  Write-Host "`n[2/3] 跳过垫片（-NoShim）"
}

# ---------------------------------------------------------------- 3. relay
Write-Host "`n[3/3] relay ($Mode, retries=$Retries)"
if ($Mode -eq 'replace' -and -not (Test-Path (Join-Path $Root 'relay\operator_override_v2.txt'))) {
  throw "缺少 relay\operator_override_v2.txt"
}
& (Join-Path $Root 'bin\start-relay.ps1') -Stop -ErrorAction SilentlyContinue | Out-Null
$holder = (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue).OwningProcess
if ($holder) {
  $proc = Get-Process -Id $holder -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -eq 'python') { Stop-Process -Id $holder -Force; Start-Sleep -Milliseconds 600 }
  else { throw "端口 $Port 被 $($proc.ProcessName)($holder) 占用" }
}
$py = 'C:\Program Files\Python311\python.exe'
$a = @((Join-Path $Root 'relay\relay.py'), '--listen', "127.0.0.1:$Port", '--mode', $Mode,
       '--log', (Join-Path $Root 'logs\relay-gui.jsonl'),
       '--capture-dir', (Join-Path $Root 'logs\capture-gui'),
       '--token-out', (Join-Path $Root 'run\last_token.json'),
       '--retry-on-refusal', "$Retries")
$a += @('--system-file', (Join-Path $Root 'relay\operator_override_v2.txt'))
if (-not $Proxy) { $Proxy = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue).ProxyServer }
if ($Proxy) { $a += @('--proxy', $Proxy); Write-Host "  upstream proxy: $Proxy" }
$p = Start-Process -FilePath $py -ArgumentList $a -PassThru -WindowStyle Hidden `
     -RedirectStandardOutput (Join-Path $Root 'logs\relay-gui.out.log') `
     -RedirectStandardError  (Join-Path $Root 'logs\relay-gui.err.log')
$p.Id | Set-Content (Join-Path $Root 'run\relay.pid')
Start-Sleep -Milliseconds 900
if ($p.HasExited) { throw "relay 启动失败，见 logs\relay-gui.err.log" }
Write-Host "  relay pid=$($p.Id)  http://127.0.0.1:$Port"

Write-Host @"

上甲完成。生效方式：
  1) 重启 Antigravity（垫片在启动时注入端点；relay 未启动会自动退回原生）
  2) 新会话里 model 选 Gemini 3 Flash（实测最不拒），或 3.1 Flash Lite / 2.5 Flash
  3) 拦截与改写记录：logs\relay-gui.jsonl
  4) 想彻底换掉产品人格提示：-Mode replace（默认已是）

离线批量出活（不依赖 GUI）：
  python tools\ask.py "你的需求" --out out.txt
  python probes\run_decompose.py

回滚：.\bin\disarm.ps1
"@



