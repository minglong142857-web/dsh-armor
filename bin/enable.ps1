# 开启 DSH 破甲中继：profile 指向本地 relay + 起进程 + 登录自启
[CmdletBinding()]
param(
  [int]$Port = 8788,
  [ValidateSet('inject','replace','off')][string]$Mode = 'inject',
  [int]$Retries = 4
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Cfg  = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml'
$Py   = 'C:\Program Files\Python311\python.exe'

# 1) 停旧进程
$old = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($old) {
  $p0 = Get-Process -Id $old.OwningProcess -ErrorAction SilentlyContinue
  if ($p0 -and $p0.ProcessName -eq 'python') { Stop-Process -Id $p0.Id -Force; Start-Sleep -Milliseconds 500 }
}

# 2) 起 relay
$p = Start-Process -FilePath $Py -ArgumentList @(
  (Join-Path $Root 'relay\dsh_relay.py'), '--listen', "127.0.0.1:$Port",
  '--mode', $Mode, '--retries', "$Retries") -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $Root 'relay\out.log') `
  -RedirectStandardError  (Join-Path $Root 'relay\err.log')
Start-Sleep -Milliseconds 900
if ($p.HasExited) { throw "relay 启动失败，见 relay\err.log" }
Write-Host "[relay] pid=$($p.Id)  http://127.0.0.1:$Port  mode=$Mode  retries=$Retries"

# 3) 写 profile patch（下次启动 DSH 生效）
Copy-Item $Cfg "$Cfg.dshrelay.bak" -Force -ErrorAction SilentlyContinue
$txt = Get-Content $Cfg -Raw -Encoding UTF8
$block = @"
- id: deepseek-account
  name: "@deepseek-ai/dsh-deepseek-account"
  config:
    inferenceOrigin: "http://127.0.0.1:$Port"
"@
if ($txt -match 'inferenceOrigin') {
  $txt = $txt -replace '(?m)^(\s*)inferenceOrigin:.*$', "`$1inferenceOrigin: `"http://127.0.0.1:$Port`""
} else {
  $txt = $txt.TrimEnd() + "`n`n" + $block + "`n"
}
Set-Content $Cfg -Value $txt -Encoding UTF8 -NoNewline
Write-Host "[profile] 已指向 relay（备份 $Cfg.dshrelay.bak）"

# 4) 登录自启
$taskName = 'dsh-armor-relay'
$action = New-ScheduledTaskAction -Execute $Py `
  -Argument "`"$(Join-Path $Root 'relay\dsh_relay.py')`" --listen 127.0.0.1:$Port --mode $Mode --retries $Retries" `
  -WorkingDirectory (Join-Path $Root 'relay')
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Force `
  -Description 'DSH armor-off relay (local LLM gateway)' | Out-Null
Write-Host "[task] 已注册登录自启: $taskName"

Write-Host @"

完成。生效方式：完全退出 DSH 再启动。
  观测：$Root\relay\dsh-relay.jsonl   （retry / exchange / refused 字段）
  关掉：.\bin\disable.ps1
"@
