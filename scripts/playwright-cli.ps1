$ErrorActionPreference = "Stop"

$argsList = @($args)
$sessionSpecified = $false

foreach ($arg in $argsList) {
  if ($arg -eq "--session" -or $arg -like "--session=*" -or $arg -like "-s=*") {
    $sessionSpecified = $true
    break
  }
}

if ($argsList.Count -eq 0) {
  Write-Host ""
  Write-Host "Использование:"
  Write-Host "  npm run browser -- --help"
  Write-Host "  npm run browser -- open https://afisha.yandex.ru/kazan --headed"
  Write-Host "  npm run browser -- snapshot"
  exit 0
}

$pwArgs = @("--yes", "--package", "@playwright/cli", "playwright-cli")

if (-not $sessionSpecified) {
  $pwArgs += "-s=kazan-event-radar"
}

$pwArgs += $argsList

& npx @pwArgs
