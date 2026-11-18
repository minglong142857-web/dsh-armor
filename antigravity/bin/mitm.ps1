# MITM 破甲中继：启动 / 停止 / 状态 / 装证书 / 还原
#   .\bin\mitm.ps1 -Start              # 起中继（inject 模式 + 模型重写 + 3 次换写）
#   .\bin\mitm.ps1 -Start -Mode replace
#   .\bin\mitm.ps1 -Stop
#   .\bin\mitm.ps1 -Status
#   .\bin\mitm.ps1 -InstallCa          # 装本地 CA 到当前用户 Root（一次即可）
#   .\bin\mitm.ps1 -Disable            # 还原：删证书 + 清代理变量
[CmdletBinding()]
param(
  [switch]$Start, [switch]$Stop, [switch]$Status,
  [switch]$InstallCa, [switch]$Disable,
  [ValidateSet('inject','replace','off')][string]$Mode = 'replace',
  [string]$SystemFile = 'relay\operator_override_v4.txt',
  [string]$RewriteModel = 'claude-sonnet-4-6',
  [string]$RewriteOnly = 'claude-sonnet-4-6,claude-opus-4-6-thinking,gpt-oss-120b-medium,gemini-3.8-flash-high,gemini-3.8-flash-medium,gemini-3.8-flash-low',
  [int]$Retries = 3,
  [int]$Port = 8790,
  [int]$UpstreamPort = 7897
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Py   = 'C:\Program Files\Python311\python.exe'
$Ca   = Join-Path $Root 'relay\ca\ca.crt'
$Log  = Join-Path $Root 'logs'

function Get-Holder([int]$p) {
  (Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
}

if ($InstallCa) {
  & certutil -addstore -user Root $Ca | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host "[ca] 已装入当前用户 Root: agy-armor local CA" }
  else { Write-Host "[ca] 安装返回 $LASTEXITCODE，可能已存在" }
}

if ($Disable) {
  & certutil -delstore -user Root "agy-armor local CA" | Out-Null
  & setx HTTPS_PROXY "" | Out-Null
  & setx HTTP_PROXY "" | Out-Null
  & setx NO_PROXY "" | Out-Null
  $h = Get-Holder $Port
  if ($h) { Stop-Process -Id $h -Force -ErrorAction SilentlyContinue }
  Write-Host "[disable] 证书已删、代理变量已清、中继已停。重启 Antigravity 生效。"
  return
}

if ($Stop) {
  $h = Get-Holder $Port
  if ($h) { Stop-Process -Id $h -Force; Write-Host "[mitm] 已停止 pid=$h" } else { Write-Host "[mitm] 未在运行" }
  return
}

if ($Status) {
  $h = Get-Holder $Port
  Write-Host ("[mitm] :{0} {1}" -f $Port, $(if ($h) { "在听 pid=$h" } else { "未运行" }))
  $u = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue).ProxyServer
  Write-Host "[env] HTTPS_PROXY=$env:HTTPS_PROXY  WinINET=$u"
  $cert = Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Subject -match 'agy-armor' }
  Write-Host ("[ca] " + $(if ($cert) { "已安装 " + $cert.Thumbprint.Substring(0, 12) } else { "未安装" }))
  if (Test-Path (Join-Path $Log 'mitm.jsonl')) {
    $rows = Get-Content (Join-Path $Log 'mitm.jsonl') -Tail 200
    $rw = @($rows | Select-String 'model_rewrite').Count
    $ex = @($rows | Select-String '"kind": "exchange"').Count
    Write-Host "[log] 最近 200 行: exchange=$ex model_rewrite=$rw"
  }
  return
}

if ($Start) {
  New-Item -ItemType Directory -Force -Path $Log | Out-Null
  $h = Get-Holder $Port
  if ($h) { Stop-Process -Id $h -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }
  $args2 = @(
    (Join-Path $Root 'relay\mitm_relay.py'), '--listen', "127.0.0.1:$Port", '--mode', $Mode,
    '--system-file', (Join-Path $Root $SystemFile), '--strip-wrappers',
    '--rewrite-model', $RewriteModel, '--rewrite-only', $RewriteOnly, '--upstream-proxy', "127.0.0.1:$UpstreamPort",
    '--retries', "$Retries", '--log', (Join-Path $Log 'mitm.jsonl')
  )
  $p = Start-Process -FilePath $Py -ArgumentList $args2 -PassThru -WindowStyle Hidden `
       -RedirectStandardError (Join-Path $Log 'mitm.err.log') -RedirectStandardOutput (Join-Path $Log 'mitm.out.log')
  Start-Sleep -Milliseconds 900
  if ($p.HasExited) { Write-Host "[mitm] 启动失败，见 logs\mitm.err.log"; Get-Content (Join-Path $Log 'mitm.err.log') -Tail 5; return }
  Write-Host ("[mitm] pid={0}  http://127.0.0.1:{1}  mode={2}  rewrite-model={3}  retries={4}" -f $p.Id, $Port, $Mode, $RewriteModel, $Retries)
  Write-Host "[mitm] 别忘了：应用要走中继，需 HTTPS_PROXY=http://127.0.0.1:$Port（-InstallCa 后 setx 一次）"
}
