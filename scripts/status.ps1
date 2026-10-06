<#
.SYNOPSIS
  查看代理链与登录态（端口、进程、虚拟登录、模型目录）。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $env:LOCALAPPDATA 'ClaudeScience\aiusage-proxy'
$stateFile = Join-Path $stateDir 'state.json'

Push-Location $root
try {
  Write-Host '=== 端口 / 进程 ===' -ForegroundColor Cyan
  node src/science-control.mjs status | Out-Host

  Write-Host "`n=== 进程与 PID ===" -ForegroundColor Cyan
  if (Test-Path $stateFile) {
    $state = Get-Content $stateFile -Raw | ConvertFrom-Json
    foreach ($entry in @(@('inferencePid', '推理代理'), @('sessionPid', '会话反代'))) {
      $proc = Get-Process -Id $state.($entry[0]) -ErrorAction SilentlyContinue
      Write-Host ("  {0}: pid={1} {2}" -f $entry[1], $state.($entry[0]), $(if ($proc) { '运行中' } else { '已退出' }))
    }
  } else {
    Write-Host '  无 state.json（未通过 start.ps1 启动）'
  }
  Get-Process -Name 'claude-science' -ErrorAction SilentlyContinue |
    Select-Object Id, ProcessName, StartTime | Format-Table -AutoSize | Out-Host

  Write-Host "`n=== 登录态（虚拟登录）===" -ForegroundColor Cyan
  node src/virtual-login.mjs inspect | Out-Host

  Write-Host "`n=== 对外发布的模型（推理代理）===" -ForegroundColor Cyan
  $cfg = Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json
  try {
    (Invoke-WebRequest "http://127.0.0.1:$($cfg.ports.inference)/v1/models" -UseBasicParsing -TimeoutSec 3).Content | Out-Host
  } catch {
    Write-Host '  推理代理未在运行'
  }
} finally {
  Pop-Location
}
