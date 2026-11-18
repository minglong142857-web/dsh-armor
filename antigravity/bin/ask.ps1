# 一句话出活（自动续 token + 自动代理 + 自动换写重试）
#   .\bin\ask.ps1 "你的真实需求"
#   .\bin\ask.ps1 "需求" -Out artifacts\x.md
#   .\bin\ask.ps1 "大件需求" -Decompose -Out artifacts\plan.md
#   .\bin\ask.ps1 "需求" -Model gemini-2.5-flash
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Prompt,
  [string]$Out = '',
  [switch]$Decompose,
  [string]$Model = 'gemini-3-flash',
  [int]$Temp = 8
)

$ErrorActionPreference = 'Continue'
$Root  = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Py    = 'C:\Program Files\Python311\python.exe'
$Token = Join-Path $Root 'run\last_token.json'
$LogDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# 1) 代理（Go / Python 都只认环境变量）
if (-not $env:HTTPS_PROXY) {
  $sys = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue).ProxyServer
  if ($sys) {
    $env:HTTPS_PROXY = "http://$sys"
    $env:HTTP_PROXY  = "http://$sys"
  }
}
if (-not $env:NO_PROXY) { $env:NO_PROXY = '127.0.0.1,localhost' }

# 2) token 新鲜度（>45 分钟先续期）
$needRefresh = $true
if (Test-Path $Token) {
  try {
    $meta = Get-Content $Token -Raw | ConvertFrom-Json
    $ageMin = ((Get-Date) - [datetimeoffset]::FromUnixTimeSeconds($meta.ts).LocalDateTime).TotalMinutes
    if ($ageMin -lt 45) { $needRefresh = $false }
  } catch { }
}
if ($needRefresh) {
  Write-Host '[ask] token 过期或缺失，先续期...'
  & (Join-Path $Root 'bin\refresh-token.ps1') | Out-Host
}

# 3) 组装参数并执行（python 的进度输出重定向到日志，避免 PS5.1 当成致命错误）
$argList = @(
  (Join-Path $Root 'tools\ask.py'),
  $Prompt,
  '--model', $Model,
  '--temperature', ('{0:N2}' -f ($Temp / 10.0))
)
if ($Out)       { $argList += @('--out', $Out) }
if ($Decompose) { $argList += '--decompose' }

$errLog = Join-Path $LogDir 'ask.err.log'
& $Py @argList 2> $errLog
$code = $LASTEXITCODE

if (Test-Path $errLog) {
  Get-Content $errLog -Tail 8 | ForEach-Object { if ($_ -match '通过|被拒|失败|Error') { Write-Host $_ } }
}
exit $code
