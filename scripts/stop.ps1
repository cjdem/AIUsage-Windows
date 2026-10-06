<#
.SYNOPSIS
  停止 Claude Science 代理链（会话反代 + 推理代理 + daemon）。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'config.json'
$stateDir = Join-Path $env:LOCALAPPDATA 'ClaudeScience\aiusage-proxy'
$stateFile = Join-Path $stateDir 'state.json'

$cfg = Get-Content $configPath -Raw | ConvertFrom-Json
$dataDir = [Environment]::ExpandEnvironmentVariables($cfg.science.dataDir)
$binary = [Environment]::ExpandEnvironmentVariables($cfg.science.binaryPath)

Write-Host '=== 停止代理链 ===' -ForegroundColor Cyan

if (Test-Path $stateFile) {
  $state = Get-Content $stateFile -Raw | ConvertFrom-Json
  foreach ($entry in @(@('sessionPid', '会话反代'), @('inferencePid', '推理代理'))) {
    $pidValue = $state.($entry[0])
    if ($pidValue) {
      $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
      if ($proc) {
        Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
        Write-Host "  已停止 $($entry[1])（pid $pidValue）"
      }
    }
  }
  Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
} else {
  Write-Host '  没有 state.json：按端口兜底清理 node 进程'
  foreach ($port in @($cfg.ports.publicEntry, $cfg.ports.inference)) {
    $conn = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    if ($conn) {
      foreach ($owner in ($conn.OwningProcess | Select-Object -Unique)) {
        $proc = Get-Process -Id $owner -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -eq 'node') {
          Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
          Write-Host "  已停止监听 :$port 的 node（pid $owner）"
        }
      }
    }
  }
}

if (Test-Path $binary) {
  & $binary stop --data-dir $dataDir 2>&1 | Select-Object -First 3 | ForEach-Object { Write-Host "  $_" }
}
Get-Process -Name 'claude-science' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Host '完成（虚拟登录凭证保留；如需移除：node src/virtual-login.mjs remove）' -ForegroundColor Green
