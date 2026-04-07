param(
  [string]$EnvPath = ".env"
)

$resolvedEnvPath = Join-Path (Get-Location) $EnvPath

if (-not (Test-Path $resolvedEnvPath)) {
  Copy-Item ".env.example" $resolvedEnvPath
}

$securePassword = Read-Host "Enter analytics admin password" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)

try {
  $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)

  if ([string]::IsNullOrWhiteSpace($password)) {
    throw "Password cannot be empty."
  }

  $lines = Get-Content $resolvedEnvPath
  $updated = $false
  $nextLines = foreach ($line in $lines) {
    if ($line -match "^ANALYTICS_PASSWORD=") {
      $updated = $true
      "ANALYTICS_PASSWORD=$password"
    } else {
      $line
    }
  }

  if (-not $updated) {
    $nextLines += "ANALYTICS_PASSWORD=$password"
  }

  Set-Content -Path $resolvedEnvPath -Value $nextLines -Encoding utf8
  Write-Host "Analytics password saved to .env"
} finally {
  if ($password) {
    $password = $null
  }

  if ($bstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}
