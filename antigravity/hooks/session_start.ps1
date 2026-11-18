# SessionStart 钩子：会话开始即注入契约
$ErrorActionPreference = 'SilentlyContinue'
$null = [Console]::In.ReadToEnd()

$hookDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ov = Join-Path $hookDir 'override.txt'
$msg = ''
if (Test-Path $ov) { $msg = [System.IO.File]::ReadAllText($ov, [System.Text.Encoding]::UTF8) }

$escaped = ConvertTo-Json -InputObject ([string]$msg) -Compress
$payload = '{"injectSteps":[{"systemMessage":{"systemMessage":' + $escaped + '}}]}'

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
$out = [Console]::OpenStandardOutput()
$out.Write($bytes, 0, $bytes.Length)
$out.Flush()
exit 0

