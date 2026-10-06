param(
  [ValidateSet("start", "stop", "status", "logs")]
  [string]$Action = "start",
  [switch]$Offline
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$pythonPath = Join-Path $projectRoot ".venv-docling\Scripts\python.exe"
$logDirectory = Join-Path $env:TEMP "knowflow-docling"
$stdoutLog = Join-Path $logDirectory "stdout.log"
$stderrLog = Join-Path $logDirectory "stderr.log"

# 查询 Docling 健康状态；服务未运行或尚未就绪时返回 null。
function Get-DoclingHealth {
  try {
    return Invoke-RestMethod "http://127.0.0.1:5001/health" -TimeoutSec 2
  } catch {
    return $null
  }
}

# 找到本项目启动的 Uvicorn 及其 Python 子进程，避免误操作其他服务。
function Get-DoclingProcesses {
  $allProcesses = @(Get-CimInstance Win32_Process)
  $pythonPattern = [regex]::Escape($pythonPath)
  $uvicornPattern = "uvicorn services\.docling\.app:app"
  $launchers = @($allProcesses | Where-Object {
    $_.CommandLine -match $pythonPattern -and $_.CommandLine -match $uvicornPattern
  })
  $matchedProcesses = @($launchers)
  foreach ($launcher in $launchers) {
    $matchedProcesses += @($allProcesses | Where-Object {
      $_.ParentProcessId -eq $launcher.ProcessId -and $_.CommandLine -match $uvicornPattern
    })
  }
  return $matchedProcesses
}

# 从启动进程树中取出实际监听服务的 PID。
function Get-DoclingServicePid {
  $processes = @(Get-DoclingProcesses)
  if ($processes.Count -eq 0) { return $null }
  $processIds = @($processes | Select-Object -ExpandProperty ProcessId)
  $serverProcess = $processes | Where-Object {
    $_.ParentProcessId -in $processIds
  } | Select-Object -First 1
  if ($null -eq $serverProcess) {
    $serverProcess = $processes | Select-Object -First 1
  }
  return [int]$serverProcess.ProcessId
}

switch ($Action) {
  "status" {
    $health = Get-DoclingHealth
    if ($null -eq $health -or $health.status -ne "ok") {
      Write-Output "Docling 未运行"
      exit 1
    }
    $servicePid = Get-DoclingServicePid
    Write-Output "Docling 运行中；PID=$servicePid；URL=http://127.0.0.1:5001"
  }
  "logs" {
    if (-not (Test-Path -LiteralPath $stderrLog)) { throw "没有 Docling 日志：$stderrLog" }
    Get-Content -LiteralPath $stderrLog -Wait
  }
  "stop" {
    $processes = @(Get-DoclingProcesses)
    if ($processes.Count -eq 0) {
      Write-Output "Docling 已停止"
      exit 0
    }
    # 先停实际服务进程，再停虚拟环境启动器进程。
    $processIds = @($processes | Select-Object -ExpandProperty ProcessId)
    $serverProcesses = @($processes | Where-Object { $_.ParentProcessId -in $processIds })
    foreach ($process in $serverProcesses) {
      Stop-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
    }
    foreach ($process in $processes | Where-Object { $_.ParentProcessId -notin $processIds }) {
      Stop-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
    }
    Write-Output "Docling 已停止"
  }
  "start" {
    $health = Get-DoclingHealth
    if ($null -ne $health -and $health.status -eq "ok") {
      $servicePid = Get-DoclingServicePid
      Write-Output "Docling 已在运行；PID=$servicePid；URL=http://127.0.0.1:5001"
      exit 0
    }
    if (-not (Test-Path -LiteralPath $pythonPath)) {
      throw "未找到 Docling Python 环境：$pythonPath。请先按 README 创建虚拟环境并安装依赖。"
    }
    if ($Offline) {
      $env:HF_HUB_OFFLINE = "1"
    } elseif ([string]::IsNullOrWhiteSpace($env:HF_ENDPOINT)) {
      $env:HF_ENDPOINT = "https://hf-mirror.com"
    }
    New-Item -ItemType Directory -Force $logDirectory | Out-Null
    # 清理上次启动日志，确保本次启动失败原因一目了然。
    Remove-Item -LiteralPath $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue
    $launcher = Start-Process `
      -FilePath $pythonPath `
      -ArgumentList @("-m", "uvicorn", "services.docling.app:app", "--host", "127.0.0.1", "--port", "5001") `
      -WorkingDirectory $projectRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutLog `
      -RedirectStandardError $stderrLog `
      -PassThru

    # 启动后轮询健康接口，避免调用方猜测服务何时就绪。
    $health = $null
    for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
      $health = Get-DoclingHealth
      if ($null -ne $health -and $health.status -eq "ok") { break }
      Start-Sleep -Seconds 1
    }
    if ($null -eq $health -or $health.status -ne "ok") {
      Get-Content -LiteralPath $stderrLog -Tail 80 -ErrorAction SilentlyContinue
      throw "Docling 启动失败；启动器 PID=$($launcher.Id)，日志=$stderrLog"
    }
    $servicePid = Get-DoclingServicePid
    Write-Output "Docling 已启动；PID=$servicePid；URL=http://127.0.0.1:5001"
    Write-Output "日志：$stderrLog"
  }
}
