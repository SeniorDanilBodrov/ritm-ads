$ErrorActionPreference = "Stop"

$appDirectory = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $appDirectory

$node = (Get-Command node -ErrorAction Stop).Source
& $node --env-file-if-exists=.env.worker scripts/ollama-remote-worker.js
