#Requires -Version 5.1
<#
Read-only for the active worktree/PM2/WhatsApp services and PostgreSQL source.
Creates a PRIVATE, non-overwriting, unverified snapshot outside the repo.
The custom PostgreSQL dump does not replace an actual disposable restore test.
No credentials, filenames from git status, or process environment are printed.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RepoPath,
  [Parameter(Mandatory = $true)][string]$BackupRoot,
  [string]$PgDumpCommand = "pg_dump",
  [string]$PgRestoreCommand = "pg_restore"
)

$ErrorActionPreference = "Stop"
$script:CreatedSnapshot = $false
$script:SnapshotId = ""
$oldGitLocks = [Environment]::GetEnvironmentVariable("GIT_OPTIONAL_LOCKS", "Process")

function Stop-Safely([string]$Code) {
  [Console]::Out.WriteLine((@{
    event = "pokemon.windows.premium.safeguard"
    ok = $false
    reason = $Code
    createdSnapshot = $script:CreatedSnapshot
    snapshotId = $script:SnapshotId
    releaseEligible = $false
  } | ConvertTo-Json -Compress))
  exit 2
}

try {
  if (-not $IsWindows -and $PSVersionTable.PSVersion.Major -ge 6) {
    Stop-Safely "WINDOWS_ONLY"
  }

  foreach ($name in @("PGHOST", "PGUSER", "PGDATABASE")) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, "Process"))) {
      Stop-Safely ("MISSING_" + $name)
    }
  }
  foreach ($command in @("git", "tar", $PgDumpCommand, $PgRestoreCommand)) {
    if ($null -eq (Get-Command -Name $command -ErrorAction SilentlyContinue)) {
      Stop-Safely "REQUIRED_TOOL_UNAVAILABLE"
    }
  }

  $source = (Resolve-Path -LiteralPath $RepoPath -ErrorAction Stop).ProviderPath
  $destination = (Resolve-Path -LiteralPath $BackupRoot -ErrorAction Stop).ProviderPath
  $source = [IO.Path]::GetFullPath($source).TrimEnd([char[]]@('\', '/'))
  $destination = [IO.Path]::GetFullPath($destination).TrimEnd([char[]]@('\', '/'))
  if ((-not [IO.Path]::IsPathRooted($source)) -or (-not [IO.Path]::IsPathRooted($destination))) {
    Stop-Safely "PATH_NOT_ABSOLUTE"
  }
  if ($destination.Equals($source, [StringComparison]::OrdinalIgnoreCase) -or
      $destination.StartsWith(($source + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Safely "BACKUP_INSIDE_WORKTREE"
  }
  if ($destination -match '(?i)(^|[\\/])(OneDrive|Dropbox|Google Drive|iCloudDrive)([\\/]|$)') {
    Stop-Safely "SYNCED_BACKUP_PATH_NOT_ALLOWED"
  }

  [Environment]::SetEnvironmentVariable("GIT_OPTIONAL_LOCKS", "0", "Process")
  $reportedRoot = @(& git --no-optional-locks -C $source rev-parse --show-toplevel 2>$null)
  $gitExit = $LASTEXITCODE
  if ($gitExit -ne 0 -or $reportedRoot.Count -ne 1) {
    Stop-Safely "NOT_A_GIT_WORKTREE"
  }
  $actualRoot = [IO.Path]::GetFullPath([string]$reportedRoot[0]).TrimEnd([char[]]@('\', '/'))
  if (-not $source.Equals($actualRoot, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Safely "REQUIRES_REPOSITORY_ROOT"
  }
  $gitHead = @(& git --no-optional-locks -C $source rev-parse --verify HEAD 2>$null)
  if ($LASTEXITCODE -ne 0 -or $gitHead.Count -ne 1 -or
      ([string]$gitHead[0]) -notmatch '^[a-f0-9]{40}$') {
    Stop-Safely "GIT_HEAD_UNAVAILABLE"
  }

  # Restrict the snapshot directory before writing any private bytes to it.
  $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
  $id = $stamp + "-" + [guid]::NewGuid().ToString("N").Substring(0, 12)
  $folder = Join-Path $destination ("pokemon-private-snapshot-" + $id)
  [void][IO.Directory]::CreateDirectory($folder)
  $script:CreatedSnapshot = $true
  $script:SnapshotId = $id

  $descriptor = New-Object System.Security.AccessControl.DirectorySecurity
  $descriptor.SetAccessRuleProtection($true, $false)
  $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
             [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $ownerSid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    $inherit,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$descriptor.AddAccessRule($rule)
  Set-Acl -LiteralPath $folder -AclObject $descriptor -ErrorAction Stop

  $incomplete = Join-Path $folder "INCOMPLETE.txt"
  [IO.File]::WriteAllText($incomplete, "Unverified backup. Never deploy solely on this evidence.")

  $sourceArchive = Join-Path $folder "source-and-ignored-files.tar.gz"
  & tar -czf $sourceArchive -C $source . 1>$null 2>$null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $sourceArchive -PathType Leaf) -or
      (Get-Item -LiteralPath $sourceArchive).Length -le 0) {
    Stop-Safely "SOURCE_ARCHIVE_FAILED"
  }
  $databaseDump = Join-Path $folder "postgres-custom.dump"
  & $PgDumpCommand --format=custom --no-owner --no-acl "--file=$databaseDump" 1>$null 2>$null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $databaseDump -PathType Leaf) -or
      (Get-Item -LiteralPath $databaseDump).Length -le 0) {
    Stop-Safely "POSTGRES_DUMP_FAILED"
  }
  & $PgRestoreCommand --list $databaseDump 1>$null 2>$null
  if ($LASTEXITCODE -ne 0) {
    Stop-Safely "DUMP_CATALOG_INVALID"
  }
  $sourceSha = (Get-FileHash -LiteralPath $sourceArchive -Algorithm SHA256).Hash.ToLowerInvariant()
  $dumpSha = (Get-FileHash -LiteralPath $databaseDump -Algorithm SHA256).Hash.ToLowerInvariant()
  $manifest = [ordered]@{
    kind = "pokemon.premium.private.safeguard"
    version = 1
    id = $id
    sourceGitHead = [string]$gitHead[0]
    sourceArchiveSha256 = $sourceSha
    postgresqlDumpSha256 = $dumpSha
    postgresqlCustomCatalogReadable = $true
    whatsappAuthKeyOutsideDatabasePreserved = $false
    disposablePostgresqlRestoreVerified = $false
    pm2RuntimeProven = $false
    gitPatchRestoreRehearsed = $false
    releaseEligible = $false
  }
  $manifestText = $manifest | ConvertTo-Json -Depth 3
  [IO.File]::WriteAllText((Join-Path $folder "manifest.json"), $manifestText)
  [IO.File]::Delete($incomplete)
  [IO.File]::WriteAllText((Join-Path $folder "CAPTURED_NOT_RESTORED.txt"),
    "Private files and a structurally readable PostgreSQL dump were captured. Restore, WhatsApp external key, PM2 and rollback remain UNVERIFIED.")
  [Console]::Out.WriteLine((@{
    event = "pokemon.windows.premium.safeguard"
    ok = $true
    reason = "CAPTURED_NOT_RESTORED"
    createdSnapshot = $true
    snapshotId = $id
    sourceGitHead = [string]$gitHead[0]
    releaseEligible = $false
    secretsPrinted = $false
  } | ConvertTo-Json -Compress))
} catch {
  Stop-Safely "SAFEGUARD_FAILED"
} finally {
  [Environment]::SetEnvironmentVariable("GIT_OPTIONAL_LOCKS", $oldGitLocks, "Process")
}
