# 构建 / 安装 / 卸载 language_server 垫片
#   .\bin\shim.ps1 -Build              # 只编译到 shim\language_server.exe
#   .\bin\shim.ps1 -Install            # 备份原生 -> language_server_real.exe，替换为垫片
#   .\bin\shim.ps1 -Install -Force     # 强制：先结束占用进程（Antigravity / language_server）再替换
#   .\bin\shim.ps1 -Uninstall          # 还原原生（同样支持 -Force）
[CmdletBinding()]
param([switch]$Build, [switch]$Install, [switch]$Uninstall, [switch]$Force)

$ErrorActionPreference = 'Stop'
$Root   = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$BinDir = "$env:LOCALAPPDATA\Programs\antigravity\resources\bin"
$Real   = Join-Path $BinDir 'language_server_real.exe'
$Shim   = Join-Path $BinDir 'language_server.exe'
$Csc    = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$Src    = Join-Path $Root 'shim\launcher.cs'
$OutDir = Join-Path $Root 'shim'

function Test-Writable([string]$path) {
  try {
    $fs = [System.IO.File]::Open($path, 'Open', 'ReadWrite', 'None')
    $fs.Close(); return $true
  } catch { return $false }
}

function Wait-Unlocked([string]$path, [int]$seconds = 20) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Writable $path) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return (Test-Writable $path)
}

function Stop-Holders {
  $killed = @()
  foreach ($n in @('Antigravity', 'language_server', 'Antigravity Helper')) {
    $ps = Get-Process -Name $n -ErrorAction SilentlyContinue
    foreach ($p in $ps) { try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; $killed += "$n($($p.Id))" } catch { } }
  }
  if ($killed.Count) { Write-Host ("[force] 已结束 " + $killed.Count + " 个进程: " + ($killed -join ', ')) }
  Start-Sleep -Seconds 1
}

function Build-Shim {
  if (-not (Test-Path $Csc)) { throw "缺少 csc.exe: $Csc" }
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  $out = Join-Path $OutDir 'language_server.exe'
  & $Csc /nologo /target:exe /platform:anycpu /optimize+ "/out:$out" $Src
  if (-not (Test-Path $out)) { throw "编译失败" }
  Write-Host "[build] $out  ($([math]::Round((Get-Item $out).Length/1KB,1)) KB)"
  return $out
}

if ($Uninstall) {
  if (-not (Test-Path $Real)) { Write-Host "[uninstall] 未发现 language_server_real.exe，无需还原"; return }
  if ($Force -or -not (Test-Writable $Shim)) { Stop-Holders | Out-Null }
  if (-not (Wait-Unlocked $Shim)) { throw "language_server.exe 仍被占用：请手动退出 Antigravity 后重试，或加 -Force" }
  Copy-Item $Real $Shim -Force
  Remove-Item $Real -Force
  Write-Host "[uninstall] 已还原原生 language_server.exe（$([math]::Round((Get-Item $Shim).Length/1MB,1)) MB）"
  return
}

if ($Build -or $Install) {
  $built = Build-Shim
  if ($Install) {
    if (-not (Test-Writable $Shim)) {
      if ($Force) { Stop-Holders | Out-Null } else {
        throw "language_server.exe 正被 Antigravity 占用。先完全退出应用，或用： .\bin\shim.ps1 -Install -Force"
      }
    }
    if (-not (Wait-Unlocked $Shim)) { throw "20s 内仍被占用，未能替换。请确认任务管理器里没有 language_server.exe" }

    if (-not (Test-Path $Real)) {
      Rename-Item $Shim $Real -Force
      Write-Host "[install] 原生已改名备份 -> language_server_real.exe"
    }
    Copy-Item $built $Shim -Force
    $sz = [math]::Round((Get-Item $Shim).Length/1KB,1)
    Write-Host "[install] 垫片已就位 ($sz KB)  → 重启 Antigravity 生效"
    Write-Host "          垫片会把端点指向 http://127.0.0.1:8787；relay 未启动时自动退回原生行为"
    Write-Host "          先起 relay：.\bin\arm.ps1   （或 .\bin\start-relay.ps1 -Mode inject）"
  }
}
