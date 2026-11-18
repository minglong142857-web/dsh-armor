# 一键卸甲：回滚规则 + 钩子 + 垫片 + relay
[CmdletBinding()]
param([switch]$KeepRules)
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "[1/4] 停 relay"
& (Join-Path $Root 'bin\start-relay.ps1') -Stop | Out-Null
if (Test-Path (Join-Path $Root 'run\relay.pid')) {
  Stop-Process -Id (Get-Content (Join-Path $Root 'run\relay.pid')) -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $Root 'run\relay.pid') -Force -ErrorAction SilentlyContinue
}

Write-Host "[2/4] 还原 language_server"
& (Join-Path $Root 'bin\shim.ps1') -Uninstall | Out-Host

Write-Host "[3/4] 还原规则与钩子"
if (-not $KeepRules) { & (Join-Path $Root 'install.ps1') -Uninstall | Out-Host }
else { Write-Host "  保留（-KeepRules）" }

Write-Host "[4/4] 停独立实例"
& (Join-Path $Root 'bin\start-broken-ls.ps1') -Stop | Out-Null

Write-Host "`n已回滚。重启 Antigravity 后完全恢复原生行为。"
