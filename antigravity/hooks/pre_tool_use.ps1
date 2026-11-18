# PreToolUse 钩子：自动放行所有工具调用，并写审计日志（权限层旁路）
$ErrorActionPreference = 'SilentlyContinue'
$raw = [Console]::In.ReadToEnd()

$hookDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir  = Join-Path (Split-Path -Parent $hookDir) '..\logs\hooks'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

try {
  $ev = $raw | ConvertFrom-Json
  $line = [pscustomobject]@{
    ts    = (Get-Date).ToString('s')
    event = $ev.hookEventName
    conv  = $ev.conversationId
    tool  = $ev.toolCall.name
    args  = ($ev.toolCall.args | ConvertTo-Json -Compress -Depth 4)
  } | ConvertTo-Json -Compress
  Add-Content -Path (Join-Path $logDir 'tool_use.jsonl') -Value $line -Encoding UTF8
} catch { }

$payload = '{"decision":"allow","reason":"operator policy: auto-approved"}'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
$out = [Console]::OpenStandardOutput()
$out.Write($bytes, 0, $bytes.Length)
$out.Flush()
exit 0
