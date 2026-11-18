<#
.SYNOPSIS
  dsh-armor 一键安装：定位宿主 → 打补丁 → 可选重建 asar → 装 shim → 打印下一步。

.DESCRIPTION
  本地：      powershell -ExecutionPolicy Bypass -File install.ps1
  连 asar：   powershell -ExecutionPolicy Bypass -File install.ps1 -Asar
  远程一行：  irm https://raw.githubusercontent.com/minglong142857-web/dsh-armor/main/install.ps1 | iex
              （远程模式会先把仓库 codeload 包下到 %TEMP%，再跑本地安装）

.PARAMETER Asar     桌面端要真正生效就带上（会重建 app.asar，自动留 .armor.bak）
.PARAMETER NoShim   不安装 dsh / armor 启动器
.PARAMETER HostDir  手动指定宿主目录（…/app/dsh/node_modules/@deepseek-ai），别名 -Host
.PARAMETER Revert   回滚：恢复 .armor.bak（含 asar）
.PARAMETER Register 顺手把 dsh-armor 注册成 profile 插件（需要 PATH 里有 dsh CLI）
.PARAMETER Profile  profile 名（默认 desktop）
#>
[CmdletBinding()]
param(
  [switch]$Asar,
  [switch]$NoShim,
  [Alias('Host')][string]$HostDir,
  [switch]$Revert,
  [switch]$Register,
  [string]$Profile = 'desktop',
  [string]$From
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

function Find-Repo {
  if (Test-Path (Join-Path $here 'bin/armor.mjs')) { return $here }
  if ($From) { return $From }
  $tmp = Join-Path $env:TEMP ("dsh-armor-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $url = 'https://codeload.github.com/minglong142857-web/dsh-armor/tar.gz/refs/heads/main'
  $tgz = Join-Path $tmp 'armor.tgz'
  Write-Host "[armor] 下载 $url" -ForegroundColor Cyan
  Invoke-WebRequest -Uri $url -OutFile $tgz -UseBasicParsing
  tar -xzf $tgz -C $tmp
  $root = Get-ChildItem $tmp -Directory | Select-Object -First 1
  return $root.FullName
}

$repo = Find-Repo
Write-Host "[armor] repo: $repo" -ForegroundColor DarkGray

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { throw "需要 node >= 18（PATH 里找不到 node）" }

$armor = Join-Path $repo 'bin/armor.mjs'
$common = @()
if ($HostDir) { $common += "--host=$HostDir" }

if ($Revert) {
  & $node $armor revert --asar @common
  if (-not $NoShim) { & $node $armor shim remove | Out-Null }
  Write-Host "[armor] 已回滚。重启宿主后生效。" -ForegroundColor Yellow
  exit $LASTEXITCODE
}

Write-Host "[armor] 1/3 打补丁（解开目录）" -ForegroundColor Cyan
& $node $armor apply @common
$code = $LASTEXITCODE

if ($Asar) {
  Write-Host "[armor] 2/3 重建 app.asar（桌面端生效面）" -ForegroundColor Cyan
  & $node $armor asar patch @common
  if ($LASTEXITCODE -ne 0) { Write-Host "[armor] asar 未全部命中，见上面的 DRIFT 行" -ForegroundColor Yellow }
} else {
  Write-Host "[armor] 2/3 跳过 asar（桌面端不会读到补丁；要生效加 -Asar）" -ForegroundColor DarkYellow
}

if (-not $NoShim) {
  Write-Host "[armor] 3/3 安装 shim（dsh / armor 启动器）" -ForegroundColor Cyan
  & $node $armor shim install | Out-Null
  $bin = Join-Path $env:USERPROFILE '.dsh\bin'
  Write-Host "      把 $bin 加进 PATH（当前会话）：" -ForegroundColor DarkGray
  Write-Host "      `$env:PATH = `"$bin;`" + `$env:PATH" -ForegroundColor DarkGray
}

if ($Register) {
  Write-Host "[armor] 4/4 注册为 profile 插件" -ForegroundColor Cyan
  & $node (Join-Path $repo 'scripts/register.mjs') "--profile=$Profile"
}

Write-Host ""
& $node $armor doctor
Write-Host ""
Write-Host "[armor] 完成。桌面端：完全退出托盘再开；CLI：用新开的终端跑 dsh。" -ForegroundColor Green
exit $code
