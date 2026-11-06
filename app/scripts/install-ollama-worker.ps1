[CmdletBinding()]
param(
  [ValidatePattern('^https://')]
  [string]$RemoteServerUrl = 'https://ritm-ads.onrender.com',
  [string]$Model = 'qwen3.5:4b',
  [string]$TaskName = 'Ritm Ollama Worker'
)

$ErrorActionPreference = 'Stop'
$appDirectory = Split-Path -Parent $PSScriptRoot
$workerScript = Join-Path $PSScriptRoot 'start-ollama-worker.ps1'
$workerEnv = Join-Path $appDirectory '.env.worker'

foreach ($command in @('node', 'ollama')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    throw "Команда $command не найдена. Установите зависимости из README и откройте новый PowerShell."
  }
}

$secureToken = Read-Host 'Вставьте REMOTE_AI_WORKER_TOKEN из Render' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}

if ([string]::IsNullOrWhiteSpace($token) -or $token.Length -lt 32) {
  throw 'REMOTE_AI_WORKER_TOKEN должен содержать не менее 32 символов.'
}

$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllLines(
  $workerEnv,
  @(
    "REMOTE_AI_SERVER_URL=$($RemoteServerUrl.TrimEnd('/'))",
    "REMOTE_AI_WORKER_TOKEN=$token",
    'OLLAMA_URL=http://127.0.0.1:11434',
    "OLLAMA_MODEL=$Model"
  ),
  $utf8WithoutBom
)
$token = $null

Write-Host "Скачиваем модель $Model..."
& ollama pull $Model
if ($LASTEXITCODE -ne 0) {
  throw "Ollama не скачала модель $Model."
}

$models = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 15
if (-not ($models.models.name -contains $Model)) {
  throw "Модель $Model не найдена в локальном Ollama API."
}

$shell = Get-Command pwsh -ErrorAction SilentlyContinue
if (-not $shell) {
  $shell = Get-Command powershell -ErrorAction Stop
}
$arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$workerScript`""
$action = New-ScheduledTaskAction -Execute $shell.Source -Argument $arguments
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

$task = Get-ScheduledTask -TaskName $TaskName
Write-Host "Готово: $($task.TaskName) — $($task.State)."
Write-Host 'После следующего входа в Windows Ollama и worker запустятся автоматически.'
