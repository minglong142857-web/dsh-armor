# 只启动 relay（配合已安装的 language_server 垫片，给 GUI 用）
[CmdletBinding()]
param(
  [ValidateSet('passthrough','inject','replace')][string]$Mode = 'inject',
  [int]$Port = 8787,
  [string]$SystemFile = '',
  [string]$Proxy = '',
  [switch]$Stop
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Log  = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $Log | Out-Null
$PidFile = Join-Path $Root 'run\relay.pid'

if ($Stop) {
  if (Test-Path $PidFile) {
    Stop-Process -Id (Get-Content $PidFile) -Force -ErrorAction SilentlyContinue
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    Write-Host "[stop] relay 已停止"
  }
  return
}

$py = 'C:\Program Files\Python311\python.exe'
$a = @((Join-Path $Root 'relay\relay.py'), '--listen', "127.0.0.1:$Port", '--mode', $Mode,
       '--log', (Join-Path $Log "relay-gui-$Mode.jsonl"),
       '--capture-dir', (Join-Path $Log "capture-gui-$Mode"),
       '--token-out', (Join-Path $Root 'run\last_token.json'))
if ($Mode -eq 'replace' -and $SystemFile) { $a += @('--system-file', $SystemFile) }
if (-not $Proxy) {
  $Proxy = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue).ProxyServer
}
if ($Proxy) { $a += @('--proxy', $Proxy); Write-Host "[relay] 上游代理 $Proxy" }

$p = Start-Process -FilePath $py -ArgumentList $a -PassThru -WindowStyle Hidden `
     -RedirectStandardOutput (Join-Path $Log "relay-gui-$Mode.out.log") `
     -RedirectStandardError  (Join-Path $Log "relay-gui-$Mode.err.log")
$p.Id | Set-Content $PidFile
Start-Sleep -Milliseconds 800
if ($p.HasExited) { throw "relay 启动失败，见 logs\relay-gui-$Mode.err.log" }
Write-Host "[relay] pid=$($p.Id)  :$Port  mode=$Mode"
Write-Host "        日志 $Log\relay-gui-$Mode.jsonl"
