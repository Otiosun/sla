#Requires -Version 7.0
$ErrorActionPreference = "Stop"

function Assert($Condition, [string]$Message) {
  if (-not $Condition) { throw "Disposable safeguard test failed: $Message" }
}

$script = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "../../scripts/operations/windows-premium-private-safeguard.ps1")).ProviderPath
$root = Join-Path $env:RUNNER_TEMP ("pokemon-windows-safeguard-" + [guid]::NewGuid().ToString("N"))
$repo = Join-Path $root "worktree"
$backupRoot = Join-Path $root "private-backups"
$mockBin = Join-Path $root "mocks"
foreach ($folder in @($repo, $backupRoot, $mockBin)) {
  [void][IO.Directory]::CreateDirectory($folder)
}

# Every mutation below affects only an ephemeral GitHub Actions fixture.
& git -C $repo init -q
if ($LASTEXITCODE -ne 0) { throw "Git fixture initialization failed" }
[IO.File]::WriteAllText((Join-Path $repo "tracked.txt"), "tracked marker")
[IO.File]::WriteAllText((Join-Path $repo ".env"), "fixture-private-token-do-not-log")
& git -C $repo add tracked.txt
& git -C $repo -c user.email=test@example.invalid -c user.name=CI commit -qm fixture
if ($LASTEXITCODE -ne 0) { throw "Git fixture commit failed" }
[IO.File]::AppendAllText((Join-Path $repo "tracked.txt"), " modified")
$indexHash = (Get-FileHash -LiteralPath (Join-Path $repo ".git/index") -Algorithm SHA256).Hash
$expectedHead = [string](& git -C $repo rev-parse HEAD)

$dumpMock = Join-Path $mockBin "mock-pg-dump.ps1"
$restoreMock = Join-Path $mockBin "mock-pg-restore.ps1"
[IO.File]::WriteAllText($dumpMock, @'
$destination = $null
foreach ($argument in $args) {
  if ($argument -like "--file=*") { $destination = $argument.Substring(7) }
}
if ([string]::IsNullOrEmpty($destination)) { exit 14 }
[IO.File]::WriteAllText($destination, "CI MOCK ONLY: NOT A REAL DATABASE DUMP")
exit 0
'@)
[IO.File]::WriteAllText($restoreMock, @'
if ($args.Count -ne 2 -or $args[0] -ne "--list") { exit 15 }
if (-not (Test-Path -LiteralPath $args[1])) { exit 16 }
exit 0
'@)

# No secret environment or PostgreSQL tools: exit before making any backup.
Remove-Item Env:PGHOST -ErrorAction SilentlyContinue
$missingOutput = @(& pwsh -NoProfile -NonInteractive -File $script -RepoPath $repo -BackupRoot $backupRoot -PgDumpCommand $dumpMock -PgRestoreCommand $restoreMock)
$missingExit = $LASTEXITCODE
$missing = ($missingOutput | Select-Object -Last 1) | ConvertFrom-Json
Assert ($missingExit -eq 2 -and $missing.reason -eq "MISSING_PGHOST") "missing environment must fail closed"
Assert ((@(Get-ChildItem -LiteralPath $backupRoot)).Count -eq 0) "failure must not create backup"

$env:PGHOST = "127.0.0.1"
$env:PGUSER = "ci"
$env:PGDATABASE = "ci_fixture"

# Refuse to create a backup within the active worktree itself.
$unsafeOutput = @(& pwsh -NoProfile -NonInteractive -File $script -RepoPath $repo -BackupRoot $repo -PgDumpCommand $dumpMock -PgRestoreCommand $restoreMock)
$unsafeExit = $LASTEXITCODE
$unsafe = ($unsafeOutput | Select-Object -Last 1) | ConvertFrom-Json
Assert ($unsafeExit -eq 2 -and $unsafe.reason -eq "BACKUP_INSIDE_WORKTREE") "in-worktree backup must be rejected"

# Synthetic success proves only safe artifact creation and private file retention.
$okOutput = @(& pwsh -NoProfile -NonInteractive -File $script -RepoPath $repo -BackupRoot $backupRoot -PgDumpCommand $dumpMock -PgRestoreCommand $restoreMock)
$okExit = $LASTEXITCODE
if ($okExit -ne 0) { throw "Snapshot fixture failed (redacted exit code $okExit)" }
$report = ($okOutput | Select-Object -Last 1) | ConvertFrom-Json
Assert ($report.ok -eq $true -and $report.releaseEligible -eq $false) "snapshot must never approve deployment"
Assert ($report.reason -eq "CAPTURED_NOT_RESTORED") "explicit restore gate required"
Assert ($report.sourceGitHead -eq $expectedHead) "source SHA mismatch"
Assert (($okOutput -join "") -notmatch "fixture-private-token") "fixture secret leaked in stdout"

$entries = @(Get-ChildItem -LiteralPath $backupRoot -Directory)
Assert ($entries.Count -eq 1) "exactly one unique backup generation expected"
$gen = $entries[0].FullName
$manifestPath = Join-Path $gen "manifest.json"
$archive = Join-Path $gen "source-and-ignored-files.tar.gz"
$dump = Join-Path $gen "postgres-custom.dump"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
Assert ($manifest.releaseEligible -eq $false -and $manifest.disposablePostgresqlRestoreVerified -eq $false) "no restore claim permitted"
Assert ($manifest.whatsappAuthKeyOutsideDatabasePreserved -eq $false) "do not claim WhatsApp key backup"
Assert ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -eq $manifest.sourceArchiveSha256) "source SHA mismatch"
Assert ((Get-FileHash -LiteralPath $dump -Algorithm SHA256).Hash.ToLowerInvariant() -eq $manifest.postgresqlDumpSha256) "PG dump SHA mismatch"
Assert (Test-Path -LiteralPath (Join-Path $gen "CAPTURED_NOT_RESTORED.txt")) "must retain restore warning"
Assert (-not (Test-Path -LiteralPath (Join-Path $gen "INCOMPLETE.txt"))) "completed capture must remove incomplete marker"
$tarEntries = @(& tar -tzf $archive)
Assert (($tarEntries | Where-Object { $_ -match '(?i)(^|/)\.env$' }).Count -ge 1) "full archive must include ignored .env"
Assert ((Get-FileHash -LiteralPath (Join-Path $repo ".git/index") -Algorithm SHA256).Hash -eq $indexHash) "source git index changed"
$acl = Get-Acl -LiteralPath $gen
Assert ($acl.AreAccessRulesProtected) "backup folder must have non-inherited private ACL"

# A failed database dump leaves an explicit incomplete generation and never
# produces a release-ready manifest or removes a previous successful snapshot.
$failMock = Join-Path $mockBin "mock-pg-dump-fail.ps1"
[IO.File]::WriteAllText($failMock, "exit 23" + [Environment]::NewLine)
$failedOutput = @(& pwsh -NoProfile -NonInteractive -File $script -RepoPath $repo -BackupRoot $backupRoot -PgDumpCommand $failMock -PgRestoreCommand $restoreMock)
$failedExit = $LASTEXITCODE
$failure = ($failedOutput | Select-Object -Last 1) | ConvertFrom-Json
Assert ($failedExit -eq 2) "failed database dump must yield a nonzero exit"
Assert ($failure.reason -eq "POSTGRES_DUMP_FAILED") "failed dump must be categorized"
Assert ($failure.releaseEligible -eq $false) "failed snapshot may never be release eligible"
$remainingGenerations = @(Get-ChildItem -LiteralPath $backupRoot -Directory)
Assert ($remainingGenerations.Count -eq 2) "failure must not overwrite or remove existing backup"
$failedGeneration = $remainingGenerations | Where-Object { $_.Name -like "*$($failure.snapshotId)" }
Assert ($null -ne $failedGeneration) "incomplete generation must remain private for operator review"
Assert (Test-Path -LiteralPath (Join-Path $failedGeneration.FullName "INCOMPLETE.txt")) "failure must leave incomplete marker"
Assert (-not (Test-Path -LiteralPath (Join-Path $failedGeneration.FullName "manifest.json"))) "failed dump must not create a completed manifest"
Assert (-not (Test-Path -LiteralPath (Join-Path $failedGeneration.FullName "CAPTURED_NOT_RESTORED.txt"))) "failed dump must not be marked captured"

# Only disposable fixtures and fake dump tools were exercised. No live database.
[Console]::Out.WriteLine("WINDOWS_SAFEGUARD_FIXTURE_PASS (mock dump; restore unverified)")
# The expected negative subprocess test leaves LASTEXITCODE=2; the test suite itself passed.
exit 0
