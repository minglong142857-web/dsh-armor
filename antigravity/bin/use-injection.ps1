# 切换 PreInvocation/SessionStart 的注入内容（不改其它钩子）
#   .\bin\use-injection.ps1 -Mode full      # v2 CODE-EMITTER（默认，措辞强）
#   .\bin\use-injection.ps1 -Mode neutral   # v3 纯格式要求（措辞中性，推荐先试）
#   .\bin\use-injection.ps1 -Mode off       # 完全停用注入，只留 PreToolUse 放行
[CmdletBinding()]
param([ValidateSet('full','neutral','off')][string]$Mode = 'neutral')

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Cfg  = Join-Path $env:USERPROFILE '.gemini\config'
$HookDir = Join-Path $Cfg 'agy-hooks'
$HooksJson = Join-Path $Cfg 'hooks.json'
$Override = Join-Path $HookDir 'override.txt'

switch ($Mode) {
  'full'    { Copy-Item (Join-Path $Root 'relay\operator_override_v2.txt') $Override -Force }
  'neutral' { Copy-Item (Join-Path $Root 'relay\operator_override_v3_neutral.txt') $Override -Force }
  'off'     { Set-Content -Path $Override -Value '' -Encoding UTF8 }
}

# hooks.json 保持无 BOM；off 模式把注入类钩子置 empty 命令，PreToolUse 保留
$j = Get-Content $HooksJson -Raw | ConvertFrom-Json
if ($Mode -eq 'off') {
  $j.'operator-contract'.SessionStart  = @()
  $j.'operator-contract'.PreInvocation = @()
} else {
  $ps = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
  if (-not $ps) { $ps = 'powershell.exe' }
  $mk = { param($n) "$ps -NoProfile -ExecutionPolicy Bypass -File $(Join-Path $HookDir $n)" }
  $j.'operator-contract'.SessionStart  = @(@{ type = 'command'; command = (& $mk 'session_start.ps1'); timeout = 15 })
  $j.'operator-contract'.PreInvocation = @(@{ type = 'command'; command = (& $mk 'pre_invocation.ps1'); timeout = 15 })
}
$txt = $j | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($HooksJson, $txt, (New-Object System.Text.UTF8Encoding($false)))

$len = (Get-Content $Override -Raw -ErrorAction SilentlyContinue)
Write-Host ("[injection] mode={0}  注入长度={1} 字符" -f $Mode, ($len | Measure-Object -Character).Characters)
Write-Host "生效方式：重启 Antigravity 或新开会话"
