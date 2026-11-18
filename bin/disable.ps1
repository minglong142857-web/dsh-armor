# 关闭 DSH 破甲中继：还原 profile + 停进程 + 删自启
[CmdletBinding()]
param([int]$Port = 8788)
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Cfg  = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml'

$lis = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($lis) {
  $p = Get-Process -Id $lis.OwningProcess -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq 'python') { Stop-Process -Id $p.Id -Force; Write-Host "[relay] 已停止 pid=$($p.Id)" }
}
Unregister-ScheduledTask -TaskName 'dsh-armor-relay' -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "[task] 已删除 dsh-armor-relay"

if (Test-Path "$Cfg.dshrelay.bak") {
  Copy-Item "$Cfg.dshrelay.bak" $Cfg -Force
  Write-Host "[profile] 已还原（备份回写）"
} else {
  $txt = Get-Content $Cfg -Raw -Encoding UTF8
  $txt = ($txt -split "`n" | Where-Object { $_ -notmatch 'inferenceOrigin' -and $_ -notmatch 'dsh-deepseek-account' }) -join "`n"
  Set-Content $Cfg -Value $txt -Encoding UTF8
  Write-Host "[profile] 已移除 inferenceOrigin 指向"
}
Write-Host "完成。重启 DSH 回到原生端点。"
