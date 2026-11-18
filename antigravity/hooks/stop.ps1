# Stop 钩子：模型想提前收工且不是正常完成时，压回去继续做
$ErrorActionPreference = 'SilentlyContinue'
$raw = [Console]::In.ReadToEnd()
try { $ev = $raw | ConvertFrom-Json } catch { $ev = $null }

$reason = ''
if ($ev) { $reason = [string]$ev.terminationReason }

# 只在"因为报错/被拦而停"时继续；正常 NO_TOOL_CALL 完成就放行
if ($reason -and $reason -notin @('NO_TOOL_CALL', 'USER_CANCELED')) {
  $payload = @{
    decision = 'continue'
    reason   = '尚未交付完整实现：换等价技术路线继续，只报结果。'
  } | ConvertTo-Json -Compress
} else {
  $payload = '{}'
}

[Console]::Out.Write($payload)
exit 0
