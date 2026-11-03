param(
  [string]$FastSdHome = $(if ($env:FASTSDCPU_HOME) { $env:FASTSDCPU_HOME } else { "D:\ritm-local-ai\fastsdcpu" }),
  [int]$Port = 8000,
  [string]$Model = $(if ($env:LOCAL_IMAGE_MODEL) { $env:LOCAL_IMAGE_MODEL } else { "OpenVINO/stable-diffusion-v1-5-int8-ov" })
)

$python = Join-Path $FastSdHome "env\Scripts\python.exe"
$entry = Join-Path $FastSdHome "src\app.py"
if (-not (Test-Path -LiteralPath $python) -or -not (Test-Path -LiteralPath $entry)) {
  throw "FastSDCPU не установлен в $FastSdHome"
}

$downloadedModel = Join-Path $env:USERPROFILE "stable-diffusion-v1-5-int8-ov"
if (-not $env:LOCAL_IMAGE_MODEL -and (Test-Path -LiteralPath $downloadedModel)) {
  $Model = $downloadedModel
}
if ((Test-Path -LiteralPath $Model) -and -not (Test-Path -LiteralPath (Join-Path $Model "model_index.json"))) {
  throw "В локальной папке модели отсутствует model_index.json: $Model"
}

$env:DEVICE = $(if ($env:LOCAL_IMAGE_DEVICE) { $env:LOCAL_IMAGE_DEVICE } else { "CPU" })
$env:HF_HOME = $(if ($env:HF_HOME) { $env:HF_HOME } else { "D:\ritm-local-ai\hf-cache" })
Set-Location -LiteralPath $FastSdHome
$fastSdArgs = @(
  $entry,
  "--api",
  "--port", $Port,
  "--use_openvino",
  "--openvino_lcm_model_id", $Model,
  "--inference_steps", 20,
  "--guidance_scale", 7.5
)
if (Test-Path -LiteralPath $Model) {
  $fastSdArgs += "--use_offline_model"
}
& $python @fastSdArgs
