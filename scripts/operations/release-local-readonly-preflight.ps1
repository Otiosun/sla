#Requires -Version 5.1
<#
  Pokemon Beyond - release preflight (READ-ONLY).
  No package manager, PM2, PostgreSQL, Baileys, network, copying, migration,
  checkout, deployment, backup, or modification of the live application.
  This reports source/build fingerprints only; it does NOT authorize release.
#>
[CmdletBinding()]
param(
  [string]$BotDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail([string]$reason) {
  Write-Output ('PREFLIGHT_READONLY_BLOCKED: ' + $reason)
  exit 1
}

if ([string]::IsNullOrWhiteSpace($BotDirectory)) {
  Fail 'EXPLICIT_BOT_DIRECTORY_REQUIRED'
}
if (-not (Test-Path -LiteralPath $BotDirectory -PathType Container)) {
  Fail 'BOT_DIRECTORY_NOT_FOUND'
}
$root = (Resolve-Path -LiteralPath $BotDirectory).ProviderPath
if (-not (Test-Path -LiteralPath (Join-Path $root '.git'))) {
  Fail 'NOT_A_GIT_WORKTREE'
}

$gitPath = Get-Command git -ErrorAction SilentlyContinue
if ($null -eq $gitPath) {
  Fail 'GIT_NOT_FOUND'
}

# Git's optional locks are disabled so status does not refresh/write the index.
$env:GIT_OPTIONAL_LOCKS = '0'

# Never mistake another checkout (notably Documents/meu-bot-rpg) for the
# actual Pokemon Beyond deploy. Do not print origin: URL could contain a token.
$originLines = @(& git --no-optional-locks -C $root config --get remote.origin.url 2>$null)
if ($LASTEXITCODE -ne 0 -or $originLines.Count -ne 1) {
  Fail 'GIT_ORIGIN_UNAVAILABLE'
}
$origin = [string]$originLines[0]
if ($origin -notmatch '^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)Otiosun/sla(\.git)?/?$') {
  Fail 'WRONG_REPOSITORY_ORIGIN'
}

$shaLines = @(& git -C $root rev-parse --verify HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or $shaLines.Count -ne 1) {
  Fail 'GIT_HEAD_UNAVAILABLE'
}
$sha = [string]$shaLines[0]
if ($sha -notmatch '^[0-9a-f]{40}$') {
  Fail 'INVALID_GIT_HEAD'
}

$branchLines = @(& git -C $root symbolic-ref --quiet --short HEAD 2>$null)
$branch = if ($LASTEXITCODE -eq 0 -and $branchLines.Count -eq 1) {
  [string]$branchLines[0]
} else {
  'DETACHED_HEAD'
}

$gitStatusLines = @(& git --no-optional-locks -C $root status --porcelain=v1 --untracked-files=normal 2>$null)
if ($LASTEXITCODE -ne 0) {
  Fail 'GIT_STATUS_UNAVAILABLE'
}
$modifiedCount = @($gitStatusLines | Where-Object { $_ -match '^.{2} ' -and $_ -notmatch '^\?\?' }).Count
$untrackedCount = @($gitStatusLines | Where-Object { $_ -match '^\?\? ' }).Count

# Hashes identify a compiled candidate, never expose or read .env, credentials,
# sessions, database records, payment logs, secrets or untracked file bodies.
$compiledCandidates = @(
  'dist/main.js',
  'dist/src/main.js',
  'dist/index.js',
  'dist/src/index.js'
)
$compiledEntries = @()
foreach ($relative in $compiledCandidates) {
  $candidate = Join-Path $root $relative
  if (Test-Path -LiteralPath $candidate -PathType Leaf) {
    $compiledEntries += [PSCustomObject]@{
      relativePath = $relative
      sha256 = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
}

$migrations = Join-Path $root 'db\migrations'
$migrationFileCount = if (Test-Path -LiteralPath $migrations -PathType Container) {
  @(Get-ChildItem -LiteralPath $migrations -File -Filter '*.sql').Count
} else {
  0
}

$report = [ordered]@{
  reportType = 'POKEMON_BEYOND_RELEASE_PREFLIGHT_READONLY'
  result = 'INSPECTION_ONLY_NOT_RELEASE_APPROVAL'
  liveFilesystemChangedByScript = $false
  repositoryIdentityVerified = $true
  gitHead = $sha
  gitBranch = $branch
  gitTrackedChanges = $modifiedCount
  gitUntrackedFiles = $untrackedCount
  compiledEntryFingerprints = $compiledEntries
  migrationSqlFilesOnDisk = $migrationFileCount
  pm2RuntimeIdentityVerified = $false
  activeDatabaseIdentityVerified = $false
  liveMigrationLedgerVerified = $false
  playerAndSessionBackupRestoredInTest = $false
  deploymentSafeToProceed = $false
}

Write-Output 'POKEMON BEYOND - RELEASE PREFLIGHT - READ ONLY'
Write-Output ($report | ConvertTo-Json -Depth 4)
Write-Output 'NO-GO: runtime/DB identity, backups/restoration and rollback are NOT verified by this script.'
) {
  Fail 'WRONG_REPOSITORY_ORIGIN'
}

$shaLines = @(& git -C $root rev-parse --verify HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or $shaLines.Count -ne 1) {
  Fail 'GIT_HEAD_UNAVAILABLE'
}
$sha = [string]$shaLines[0]
if ($sha -notmatch '^[0-9a-f]{40}$') {
  Fail 'INVALID_GIT_HEAD'
}

$branchLines = @(& git -C $root symbolic-ref --quiet --short HEAD 2>$null)
$branch = if ($LASTEXITCODE -eq 0 -and $branchLines.Count -eq 1) {
  [string]$branchLines[0]
} else {
  'DETACHED_HEAD'
}

$gitStatusLines = @(& git --no-optional-locks -C $root status --porcelain=v1 --untracked-files=normal 2>$null)
if ($LASTEXITCODE -ne 0) {
  Fail 'GIT_STATUS_UNAVAILABLE'
}
$modifiedCount = @($gitStatusLines | Where-Object { $_ -match '^.{2} ' -and $_ -notmatch '^\?\?' }).Count
$untrackedCount = @($gitStatusLines | Where-Object { $_ -match '^\?\? ' }).Count

# Hashes identify a compiled candidate, never expose or read .env, credentials,
# sessions, database records, payment logs, secrets or untracked file bodies.
$compiledCandidates = @(
  'dist/main.js',
  'dist/src/main.js',
  'dist/index.js',
  'dist/src/index.js'
)
$compiledEntries = @()
foreach ($relative in $compiledCandidates) {
  $candidate = Join-Path $root $relative
  if (Test-Path -LiteralPath $candidate -PathType Leaf) {
    $compiledEntries += [PSCustomObject]@{
      relativePath = $relative
      sha256 = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
}

$migrations = Join-Path $root 'db\migrations'
$migrationFileCount = if (Test-Path -LiteralPath $migrations -PathType Container) {
  @(Get-ChildItem -LiteralPath $migrations -File -Filter '*.sql').Count
} else {
  0
}

$report = [ordered]@{
  reportType = 'POKEMON_BEYOND_RELEASE_PREFLIGHT_READONLY'
  result = 'INSPECTION_ONLY_NOT_RELEASE_APPROVAL'
  liveFilesystemChangedByScript = $false
  gitHead = $sha
  gitBranch = $branch
  gitTrackedChanges = $modifiedCount
  gitUntrackedFiles = $untrackedCount
  compiledEntryFingerprints = $compiledEntries
  migrationSqlFilesOnDisk = $migrationFileCount
  pm2RuntimeIdentityVerified = $false
  activeDatabaseIdentityVerified = $false
  liveMigrationLedgerVerified = $false
  playerAndSessionBackupRestoredInTest = $false
  deploymentSafeToProceed = $false
}

Write-Output 'POKEMON BEYOND - RELEASE PREFLIGHT - READ ONLY'
Write-Output ($report | ConvertTo-Json -Depth 4)
Write-Output 'NO-GO: runtime/DB identity, backups/restoration and rollback are NOT verified by this script.'
