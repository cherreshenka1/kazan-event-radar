param(
  [string]$EnvPath = ".env"
)

$resolvedEnvPath = Join-Path (Get-Location) $EnvPath

if (-not (Test-Path $resolvedEnvPath)) {
  Copy-Item ".env.example" $resolvedEnvPath
}

$secureToken = Read-Host "Enter Telegram bot token" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)

try {
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)

  if ([string]::IsNullOrWhiteSpace($token)) {
    throw "Token cannot be empty."
  }

  $lines = Get-Content $resolvedEnvPath
  $updated = $false
  $nextLines = foreach ($line in $lines) {
    if ($line -match "^TELEGRAM_BOT_TOKEN=") {
      $updated = $true
      "TELEGRAM_BOT_TOKEN=$token"
    } else {
      $line
    }
  }

  if (-not $updated) {
    $nextLines += "TELEGRAM_BOT_TOKEN=$token"
  }

  Set-Content -Path $resolvedEnvPath -Value $nextLines -Encoding utf8
  Write-Host "Telegram token saved to .env"
} finally {
  if ($token) {
    $token = $null
  }

  if ($bstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}
