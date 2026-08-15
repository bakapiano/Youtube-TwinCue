param(
  [string]$ProfileName = 'Default',
  [string]$Destination = (Join-Path (Split-Path -Parent $PSScriptRoot) '.browser-profile\chrome')
)

$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data')).Path
$sourceProfile = Join-Path $sourceRoot $ProfileName
$cookiePath = Join-Path $sourceProfile 'Network\Cookies'
$projectRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$destinationRoot = [System.IO.Path]::GetFullPath($Destination)

if (-not $destinationRoot.StartsWith("$projectRoot\", [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Destination must stay inside the project: $projectRoot"
}

try {
  $cookieHandle = [System.IO.File]::Open(
    $cookiePath,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::None
  )
  $cookieHandle.Dispose()
} catch {
  throw 'Chrome is still using the profile. Fully exit Chrome, then run this script again.'
}

New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceRoot 'Local State') -Destination (Join-Path $destinationRoot 'Local State') -Force

$destinationProfile = Join-Path $destinationRoot $ProfileName
$excludedDirectories = @(
  (Join-Path $sourceProfile 'Cache'),
  (Join-Path $sourceProfile 'Code Cache'),
  (Join-Path $sourceProfile 'GPUCache'),
  (Join-Path $sourceProfile 'DawnCache'),
  (Join-Path $sourceProfile 'GrShaderCache'),
  (Join-Path $sourceProfile 'GraphiteDawnCache'),
  (Join-Path $sourceProfile 'ShaderCache'),
  (Join-Path $sourceProfile 'Media Cache'),
  (Join-Path $sourceProfile 'Service Worker\CacheStorage'),
  (Join-Path $sourceProfile 'Service Worker\ScriptCache'),
  (Join-Path $sourceProfile 'Sessions')
)

$robocopyArguments = @(
  $sourceProfile,
  $destinationProfile,
  '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/XJ',
  '/NFL', '/NDL', '/NJH', '/NJS', '/NP',
  '/XF', 'LOCK', 'SingletonCookie', 'SingletonLock', 'SingletonSocket',
  '/XD'
) + $excludedDirectories

& robocopy @robocopyArguments
$robocopyCode = $LASTEXITCODE
if ($robocopyCode -ge 8) {
  throw "Profile copy failed with robocopy exit code $robocopyCode"
}

$requiredFiles = @(
  (Join-Path $destinationRoot 'Local State'),
  (Join-Path $destinationProfile 'Preferences'),
  (Join-Path $destinationProfile 'Network\Cookies')
)
foreach ($requiredFile in $requiredFiles) {
  if (-not (Test-Path -LiteralPath $requiredFile)) {
    throw "Required profile file was not copied: $requiredFile"
  }
}

Write-Host "Copied Chrome profile '$ProfileName' into the project's ignored .browser-profile directory."
