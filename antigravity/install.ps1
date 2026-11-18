# Antigravity 破甲安装器（规则层 + 钩子层）
# 用法:
#   .\install.ps1                          # 装全局规则与钩子
#   .\install.ps1 -Workspace "D:\proj"     # 同时给某个仓库装 .agents/rules
#   .\install.ps1 -Uninstall               # 还原

[CmdletBinding()]
param(
  [string]$Workspace = '',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$Root      = $PSScriptRoot
$CfgDir    = Join-Path $env:USERPROFILE '.gemini\config'
$HookDir   = Join-Path $CfgDir 'agy-hooks'
$HooksJson = Join-Path $CfgDir 'hooks.json'
$AgentsMd  = Join-Path $CfgDir 'AGENTS.md'
$BakSuffix = '.agybreak.bak'

New-Item -ItemType Directory -Force -Path $CfgDir | Out-Null

# ------------------------------------------------------------------ 卸载
if ($Uninstall) {
  foreach ($f in @($HooksJson, $AgentsMd)) {
    if (Test-Path ($f + $BakSuffix)) {
      Move-Item ($f + $BakSuffix) $f -Force
      Write-Host "[还原] $f"
    } elseif (Test-Path $f) {
      Remove-Item $f -Force
      Write-Host "[移除] $f"
    }
  }
  if (Test-Path $HookDir) { Remove-Item $HookDir -Recurse -Force; Write-Host "[移除] $HookDir" }
  if ($Workspace) {
    $wr = Join-Path $Workspace '.agents\rules\00-operator.md'
    if (Test-Path $wr) { Remove-Item $wr -Force; Write-Host "[移除] $wr" }
  }
  Write-Host "已还原。重启 Antigravity 生效。"
  return
}

# ------------------------------------------------------------------ 1. 钩子脚本
Write-Host "[1/3] 部署钩子脚本 -> $HookDir"
New-Item -ItemType Directory -Force -Path $HookDir | Out-Null
Copy-Item (Join-Path $Root 'hooks\pre_invocation.ps1') $HookDir -Force
Copy-Item (Join-Path $Root 'hooks\session_start.ps1')  $HookDir -Force
Copy-Item (Join-Path $Root 'hooks\pre_tool_use.ps1')   $HookDir -Force
Copy-Item (Join-Path $Root 'hooks\stop.ps1')           $HookDir -Force
Copy-Item (Join-Path $Root 'relay\operator_override_v2.txt') (Join-Path $HookDir 'override.txt') -Force

# ------------------------------------------------------------------ 2. hooks.json
Write-Host "[2/3] 写 hooks.json"
$psExe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $psExe) { $psExe = 'powershell.exe' }
$ps = "$psExe -NoProfile -ExecutionPolicy Bypass -File"
$q  = { param($n) (Join-Path $HookDir $n) }
$cfg = [ordered]@{
  'operator-contract' = [ordered]@{
    SessionStart = @(
      @{ type = 'command'; command = "$ps $(& $q 'session_start.ps1')"; timeout = 15 }
    )
    PreInvocation = @(
      @{ type = 'command'; command = "$ps $(& $q 'pre_invocation.ps1')"; timeout = 15 }
    )
    PreToolUse = @(
      @{ matcher = '*'; hooks = @(@{ type = 'command'; command = "$ps $(& $q 'pre_tool_use.ps1')"; timeout = 15 }) }
    )
    Stop = @(
      @{ type = 'command'; command = "$ps $(& $q 'stop.ps1')"; timeout = 15 }
    )
  }
}
if (Test-Path $HooksJson) { Copy-Item $HooksJson ($HooksJson + $BakSuffix) -Force }
$cfg | ConvertTo-Json -Depth 8 | Set-Content $HooksJson -Encoding UTF8

# ------------------------------------------------------------------ 3. 全局规则
Write-Host "[3/3] 写全局规则 -> $AgentsMd"
if (Test-Path $AgentsMd) { Copy-Item $AgentsMd ($AgentsMd + $BakSuffix) -Force }
Copy-Item (Join-Path $Root 'rules\AGENTS.md') $AgentsMd -Force

if ($Workspace) {
  $wr = Join-Path $Workspace '.agents\rules'
  New-Item -ItemType Directory -Force -Path $wr | Out-Null
  Copy-Item (Join-Path $Root 'rules\workspace-rules.md') (Join-Path $wr '00-operator.md') -Force
  Write-Host "  仓库规则 -> $(Join-Path $wr '00-operator.md')"
}

# ------------------------------------------------------------------ 自检
Write-Host ""
Write-Host "自检:"
$probe = '{"hookEventName":"PreToolUse","toolCall":{"name":"run_command","args":{"CommandLine":"echo hi"}},"conversationId":"selfcheck"}'
$out = $probe | & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $HookDir 'pre_tool_use.ps1')
Write-Host "  PreToolUse  -> $out"
$out2 = '{}' | & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $HookDir 'pre_invocation.ps1')
Write-Host "  PreInvocation 长度 -> $($out2.Length)"
Write-Host ""
Write-Host "完成。重启 Antigravity（或新开会话）后生效；钩子日志: $Root\logs\hooks\tool_use.jsonl"

