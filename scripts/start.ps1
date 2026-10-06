<#
.SYNOPSIS
  一键启动 Windows 版 Claude Science 代理链（推理代理 + daemon + 会话反代）。

.DESCRIPTION
  顺序：
    1. 备份真实 data-dir 的凭据/状态文件（只读复制）
    2. 确保登录态（无真实登录时写入虚构凭证，让 Science 认为已登录）
    3. 清掉上次残留（daemon + 两个 node 代理）
    4. 起推理代理（默认 14402）
    5. 以我们的 env 起 daemon（默认内部 8010 / 沙箱 8001）
    6. 等 daemon 健康
    7. 起会话反代（默认 8000 → 8010）
    8. 自探公开入口后打开浏览器

  安全：不写系统环境变量（env 只作用于本脚本派生的子进程）；不修改 Science 二进制。
#>
[CmdletBinding()]
param(
  [switch]$NoBrowser,
  [switch]$SkipBackup,
  [int]$HealthTimeoutSec = 120
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'config.json'
$stateDir = Join-Path $env:LOCALAPPDATA 'ClaudeScience\aiusage-proxy'
$stateFile = Join-Path $stateDir 'state.json'
$logDir = Join-Path $stateDir 'logs'
New-Item -ItemType Directory -Force -Path $stateDir, $logDir | Out-Null

if (-not (Test-Path $configPath)) { throw "缺少配置文件：$configPath（可从 config.example.json 复制）" }
$cfg = Get-Content $configPath -Raw | ConvertFrom-Json
$dataDir = [Environment]::ExpandEnvironmentVariables($cfg.science.dataDir)
$binary = [Environment]::ExpandEnvironmentVariables($cfg.science.binaryPath)
$inferencePort = [int]$cfg.ports.inference
$publicPort = [int]$cfg.ports.publicEntry
$daemonPort = [int]$cfg.ports.daemon
$sandboxPort = [int]$cfg.ports.sandbox
$placeholderKey = 'sk-aiusage-local-proxy-key'

Write-Host '=== Claude Science 代理链启动 ===' -ForegroundColor Cyan
Write-Host "data-dir : $dataDir"
Write-Host "binary   : $binary"
Write-Host "端口     : 推理 $inferencePort / 公开 $publicPort / daemon $daemonPort / 沙箱 $sandboxPort"

if (-not (Test-Path $binary)) { throw "找不到 Claude Science：$binary" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'PATH 里找不到 node' }

Push-Location $root
try {
  # 1) 备份
  if (-not $SkipBackup) {
    Write-Host "`n[1/8] 备份真实 data-dir（只读复制）..." -ForegroundColor Yellow
    node src/science-control.mjs backup | Out-Host
  }

  # 2) 登录态
  Write-Host "`n[2/8] 检查登录态..." -ForegroundColor Yellow
  $info = (node src/virtual-login.mjs inspect | Out-String) | ConvertFrom-Json
  if ($info.hasRealLogin) {
    Write-Host '  检测到真实 Claude 登录：直接复用，不写虚拟凭证。' -ForegroundColor Green
  } elseif (@($info.tokens).Count -gt 0) {
    Write-Host '  已有本工具写入的虚拟登录：复用。' -ForegroundColor Green
  } else {
    Write-Host '  无任何登录凭证：写入虚拟登录（虚构账号，不联网）。' -ForegroundColor Yellow
    node src/virtual-login.mjs write | Out-Host
  }

  # 3) 清残留
  Write-Host "`n[3/8] 清理上次残留..." -ForegroundColor Yellow
  if (Test-Path $stateFile) {
    $old = Get-Content $stateFile -Raw | ConvertFrom-Json
    foreach ($procId in @($old.inferencePid, $old.sessionPid)) {
      if ($procId) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue }
    }
    Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
  }
  & $binary stop --data-dir $dataDir 2>&1 | Out-Null
  Get-Process -Name 'claude-science' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

  # 4) 推理代理
  Write-Host "`n[4/8] 启动推理代理（:$inferencePort）..." -ForegroundColor Yellow
  $inference = Start-Process -FilePath 'node' -ArgumentList 'src/inference-server.mjs' -WorkingDirectory $root `
    -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'inference.log') `
    -RedirectStandardError (Join-Path $logDir 'inference.err.log') -PassThru
  $ready = $false
  for ($i = 0; $i -lt 20; $i++) {
    try { $null = Invoke-WebRequest "http://127.0.0.1:$inferencePort/health" -UseBasicParsing -TimeoutSec 2; $ready = $true; break } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $ready) { throw "推理代理未就绪（:$inferencePort）" }

  # 5) daemon（env 只作用于该子进程）
  Write-Host "`n[5/8] 启动 Claude Science daemon（内部 :$daemonPort）..." -ForegroundColor Yellow
  $env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$inferencePort"
  $env:ANTHROPIC_API_KEY = $placeholderKey
  $env:ANTHROPIC_AUTH_TOKEN = $placeholderKey
  $env:no_proxy = '127.0.0.1,localhost,::1'
  $env:NO_PROXY = '127.0.0.1,localhost,::1'
  $daemonArgs = @('serve', '--data-dir', $dataDir, '--port', "$daemonPort", '--sandbox-port', "$sandboxPort", '--detached', '--no-browser')
  if ($cfg.science.noAutoUpdate -ne $false) { $daemonArgs += '--no-auto-update' }
  Start-Process -FilePath $binary -ArgumentList $daemonArgs -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir 'daemon-serve.log') `
    -RedirectStandardError (Join-Path $logDir 'daemon-serve.err.log') | Out-Null

  # 6) 等健康
  Write-Host "`n[6/8] 等待 daemon 就绪（最多 ${HealthTimeoutSec}s）..." -ForegroundColor Yellow
  $healthy = $false
  for ($i = 0; $i -lt $HealthTimeoutSec; $i++) {
    try {
      $r = Invoke-WebRequest "http://127.0.0.1:$daemonPort/health" -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { $healthy = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
  }
  if (-not $healthy) {
    Stop-Process -Id $inference.Id -Force -ErrorAction SilentlyContinue
    throw "daemon 未在 ${HealthTimeoutSec}s 内就绪，已回滚（详见 $logDir\daemon-serve.err.log）"
  }
  Write-Host "  daemon 就绪（等待 ${i}s）" -ForegroundColor Green

  # 7) 会话反代
  Write-Host "`n[7/8] 启动会话反代（:$publicPort → :$daemonPort）..." -ForegroundColor Yellow
  $session = Start-Process -FilePath 'node' -ArgumentList 'src/session-proxy.mjs' -WorkingDirectory $root `
    -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'session.log') `
    -RedirectStandardError (Join-Path $logDir 'session.err.log') -PassThru
  $proxied = $false
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $r = Invoke-WebRequest "http://127.0.0.1:$publicPort/" -UseBasicParsing -TimeoutSec 3 -MaximumRedirection 0
      if ($r.StatusCode -eq 200) { $proxied = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
  }

  # 8) 状态与浏览器
  @{ inferencePid = $inference.Id; sessionPid = $session.Id; startedAt = (Get-Date).ToString('o'); publicPort = $publicPort } |
    ConvertTo-Json | Set-Content -Path $stateFile -Encoding UTF8

  Write-Host "`n[8/8] 完成" -ForegroundColor Cyan
  if ($proxied) {
    Write-Host "  公开入口就绪：http://localhost:$publicPort/（已登录，无需点一次性链接）" -ForegroundColor Green
    if (-not $NoBrowser) { Start-Process "http://localhost:$publicPort/" | Out-Null }
  } else {
    Write-Host "  ⚠ 公开入口自探未通过，请查看 $logDir\session.log；也可直接用一次性链接：" -ForegroundColor Yellow
    node src/science-control.mjs url | Out-Host
  }
  Write-Host "`n停止：pwsh scripts/stop.ps1    状态：pwsh scripts/status.ps1"
} finally {
  Pop-Location
}
