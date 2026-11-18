# PreInvocation 钩子：每次调模型前注入操作者契约（对抗上下文漂移 / 压缩丢失）
$ErrorActionPreference = 'SilentlyContinue'
$null = [Console]::In.ReadToEnd()

$hookDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ov = Join-Path $hookDir 'override.txt'
$msg = ''
if (Test-Path $ov) { $msg = [System.IO.File]::ReadAllText($ov, [System.Text.Encoding]::UTF8) }

# 用 .NET 序列化字符串，保证转义正确、无 PSObject 包装
$escaped = ConvertTo-Json -InputObject ([string]$msg) -Compress
$payload = '{"injectSteps":[{"systemMessage":{"systemMessage":' + $escaped + '}}]}'

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
$out = [Console]::OpenStandardOutput()
$out.Write($bytes, 0, $bytes.Length)
$out.Flush()
exit 0

