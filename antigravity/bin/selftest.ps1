# Antigravity 破甲自检：把"能自动判定的"全跑一遍，输出 OK/FAIL 表
#   .\bin\selftest.ps1
#   .\bin\selftest.ps1 -SkipApi     # 不查在线模型列表
[CmdletBinding()]
param([switch]$SkipApi)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Cfg  = Join-Path $env:USERPROFILE '.gemini\config'
$HookDir = Join-Path $Cfg 'agy-hooks'
$HooksJson = Join-Path $Cfg 'hooks.json'
$LsLog = Join-Path $env:APPDATA 'Antigravity\logs\language_server.log'
$ToolLog = Join-Path $Root 'logs\hooks\tool_use.jsonl'
$rows = @()

function Add-Row($name, $ok, $detail) {
  $script:rows += [pscustomobject]@{ 检查 = $name; 结果 = $(if ($ok) { 'OK' } else { 'FAIL' }); 依据 = $detail }
}

# ---------------------------------------------------------------- 1. hooks.json 结构
$jsonOk = $false; $jsonDetail = 'missing'
if (Test-Path $HooksJson) {
  $bytes = [System.IO.File]::ReadAllBytes($HooksJson)
  $bom = ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191)
  try {
    $j = Get-Content $HooksJson -Raw | ConvertFrom-Json
    $events = ($j.'operator-contract'.PSObject.Properties.Name) -join ','
    $jsonOk = (-not $bom) -and ($events -match 'PreInvocation') -and ($events -match 'PreToolUse')
    $jsonDetail = "BOM=$bom 事件=$events"
  } catch {
    $jsonDetail = "解析失败: $($_.Exception.Message.Substring(0,[Math]::Min(60,$_.Exception.Message.Length)))"
  }
} else {
  $jsonDetail = '文件不存在'
}
Add-Row 'hooks.json 可解析且无 BOM' $jsonOk $jsonDetail

# ---------------------------------------------------------------- 2. 四条钩子真实可执行
if (Test-Path $HooksJson) {
  $j = Get-Content $HooksJson -Raw | ConvertFrom-Json
  $oc = $j.'operator-contract'
  $cases = @(
    @{ ev = 'SessionStart';  cmd = $oc.SessionStart[0].command;   stdin = '{"hookEventName":"SessionStart","conversationId":"selftest"}' },
    @{ ev = 'PreInvocation'; cmd = $oc.PreInvocation[0].command;  stdin = '{"hookEventName":"PreInvocation","conversationId":"selftest"}' },
    @{ ev = 'PreToolUse';    cmd = $oc.PreToolUse[0].hooks[0].command; stdin = '{"hookEventName":"PreToolUse","toolCall":{"name":"run_command","args":{"CommandLine":"echo hi"}},"conversationId":"selftest"}' },
    @{ ev = 'Stop';          cmd = $oc.Stop[0].command;           stdin = '{"hookEventName":"Stop","terminationReason":"NO_TOOL_CALL","conversationId":"selftest"}' }
  )
  foreach ($c in $cases) {
    $out = $c.stdin | cmd /c $c.cmd 2>&1
    $text = ($out -join '')
    $valid = $false
    try { $null = $text | ConvertFrom-Json; $valid = $true } catch { }
    $quoted = $c.cmd -match '"-File'
    $ok = ($LASTEXITCODE -eq 0) -and $valid -and (-not $quoted)
    Add-Row "$($c.ev) 钩子可执行" $ok ("exit=$LASTEXITCODE JSON=$valid 引号=$quoted 输出=$($text.Length)字符")
  }
}

# ---------------------------------------------------------------- 3. 规则层落地位置
$rulePaths = @(
  (Join-Path $Cfg 'AGENTS.md'),
  (Join-Path $Cfg '.agents\rules\00-operator.md'),
  (Join-Path $env:USERPROFILE '.gemini\AGENTS.md'),
  (Join-Path $env:USERPROFILE '.gemini\GEMINI.md')
)
$present = @($rulePaths | Where-Object { (Test-Path $_) -and ((Get-Item $_).Length -gt 200) })
Add-Row '规则文件已落地' ($present.Count -ge 1) ("$($present.Count)/4 处存在:" + (($rulePaths | ForEach-Object { Split-Path $_ -Leaf }) -join ','))

# ---------------------------------------------------------------- 4. LS 日志里的钩子报错
if (Test-Path $LsLog) {
  $tail = Get-Content $LsLog -Tail 400 -ErrorAction SilentlyContinue
  $hookFail = @($tail | Select-String -Pattern 'hook .*(failed|stderr)' -ErrorAction SilentlyContinue)
  $hookFire = @($tail | Select-String -Pattern 'jsonhook__operator-contract' -ErrorAction SilentlyContinue)
  Add-Row '最近 400 行无钩子失败' ($hookFail.Count -eq 0) ("失败行=$($hookFail.Count) 调用痕迹=$($hookFire.Count)")
  if ($hookFail.Count -gt 0) {
    Add-Row '  失败样例' $false ($hookFail[0].Line.Substring(0, [Math]::Min(120, $hookFail[0].Line.Length)))
  }
} else {
  Add-Row 'LS 日志可读' $false '找不到 language_server.log'
}

# ---------------------------------------------------------------- 5. 工具放行审计日志
if (Test-Path $ToolLog) {
  $n = (Get-Content $ToolLog | Measure-Object).Count
  $last = Get-Content $ToolLog -Tail 1
  Add-Row 'PreToolUse 审计日志已有记录' ($n -gt 0) ("行数=$n 最后一条=" + $last.Substring(0, [Math]::Min(90, $last.Length)))
} else {
  Add-Row 'PreToolUse 审计日志已有记录' $false '还没被触发（在 GUI 里让它跑一条命令才会写）'
}

# ---------------------------------------------------------------- 6. 中继 / token（离线通道）
$relayUp = [bool](Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue)
Add-Row 'relay :8787 在听' $relayUp $(if ($relayUp) { 'yes' } else { 'no（只有离线通道需要）' })
$tokPath = Join-Path $Root 'run\last_token.json'
if (Test-Path $tokPath) {
  $t = Get-Content $tokPath -Raw | ConvertFrom-Json
  $age = [math]::Round(((Get-Date) - [datetimeoffset]::FromUnixTimeSeconds($t.ts).LocalDateTime).TotalMinutes, 1)
  Add-Row 'token 有效期' ($age -lt 55) "年龄 $age 分钟（55 分钟需续期）"
} else {
  Add-Row 'token 有效期' $false '无 token，跑 .\bin\refresh-token.ps1'
}

# ---------------------------------------------------------------- 7. 在线模型清单
if (-not $SkipApi -and $relayUp -and (Test-Path $tokPath)) {
  $sys = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue).ProxyServer
  if ($sys) {
    if ($sys -notmatch '^https?://') { $sys = "http://$sys" }
    $env:HTTPS_PROXY = $sys
    $env:HTTP_PROXY  = $sys
  }
  $pyScript = Join-Path $Root 'tools\selftest_models.py'
  $out = & 'C:\Program Files\Python311\python.exe' $pyScript 2>&1
  $line = ($out | Where-Object { $_ -match '^\d+,' } | Select-Object -First 1)
  Add-Row '在线模型清单可取' ([bool]$line) $(if ($line) { "模型数/前几个: $line" } else { '取失败（看代理/token）' })
}

# ---------------------------------------------------------------- 汇总
$rows | Format-Table -AutoSize | Out-String -Width 200
$fail = @($rows | Where-Object { $_.结果 -eq 'FAIL' })
"通过 " + ($rows.Count - $fail.Count) + " / " + $rows.Count
if ($fail.Count -gt 0) {
  ""
  "需要人工处理的项："
  $fail | ForEach-Object { "  - " + $_.检查 + "  (" + $_.依据 + ")" }
}
