param(
  [string]$YandexStatePath = "data/playwright/yandex-state.json",
  [string]$KassirStatePath = "data/playwright/kassir-state.json"
)

$ErrorActionPreference = "Stop"

function Get-Base64Content {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Файл не найден: $Path"
  }

  $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $Path))
  return [Convert]::ToBase64String($bytes)
}

$yandexBase64 = Get-Base64Content -Path $YandexStatePath
$kassirBase64 = Get-Base64Content -Path $KassirStatePath

Write-Host ""
Write-Host "GitHub Secrets для браузерных auth state готовы." -ForegroundColor Green
Write-Host ""
Write-Host "YANDEX_AUTH_STATE_B64:" -ForegroundColor Cyan
Write-Output $yandexBase64
Write-Host ""
Write-Host "KASSIR_AUTH_STATE_B64:" -ForegroundColor Cyan
Write-Output $kassirBase64
Write-Host ""
Write-Host "Вставьте эти значения в GitHub -> Settings -> Secrets and variables -> Actions." -ForegroundColor Yellow
