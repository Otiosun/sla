# Pokemon Beyond - diagnostico local estritamente somente leitura
# PowerShell 5.1+ / Windows. Nao aplica commits, migra, reinicia, instala ou abre DB.
[CmdletBinding()]
param([string] $RepoPath = (Get-Location).Path)

$ErrorActionPreference = 'Stop'
# Prevent optional Git index locks and refresh writes during status.
$env:GIT_OPTIONAL_LOCKS = '0'

function Show-Safe([string] $Label, [object] $Value) {
    Write-Output ('{0}: {1}' -f $Label, $Value)
}

function Flag-NumberState([object] $Env, [string] $Name) {
    if ($null -eq $Env) { return 'NAO_INSPECIONADO' }
    $item = $Env.PSObject.Properties[$Name]
    if ($null -eq $item -or $null -eq $item.Value) { return 'AUSENTE' }
    $value = [string] $item.Value
    if ([string]::IsNullOrWhiteSpace($value)) { return 'VAZIO' }
    [long] $number = 0
    if ([long]::TryParse($value, [ref] $number) -and $number -gt 0) {
        return 'PRESENTE_INTEIRO_POSITIVO'
    }
    return 'PRESENTE_INVALIDO'
}

Write-Output '=== POKEMON BEYOND / PREFLIGHT READ-ONLY ==='
Show-Safe 'Horario local' (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')
Show-Safe 'Versao PowerShell' $PSVersionTable.PSVersion.ToString()
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Output 'Git nao encontrado; nao foi possivel verificar a arvore local.'
    exit 0
}
try {
    $root = (Resolve-Path -LiteralPath $RepoPath -ErrorAction Stop).Path
} catch {
    Write-Output 'Pasta nao encontrada; nenhuma alteracao feita.'
    exit 0
}
& git -C $root rev-parse --is-inside-work-tree 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Output 'Pasta nao e repositorio Git; nenhuma alteracao feita.'
    exit 0
}

Write-Output '--- GIT ---'
Show-Safe 'Branch' (& git -C $root branch --show-current 2>$null | Select-Object -First 1)
Show-Safe 'Commit HEAD' (& git -C $root rev-parse HEAD 2>$null | Select-Object -First 1)
$changes = @(& git -c core.fsmonitor=false -C $root status --porcelain=v1 --untracked-files=normal 2>$null)
Show-Safe 'Total de arquivos alterados/novos (sem nomes)' $changes.Count
if ($changes.Count -gt 0) {
    Write-Output 'IMPORTANTE: preservar as alteracoes locais antes de trocar de branch.'
}
Write-Output 'HEAD Git e o commit do diretorio, NAO prova o JavaScript carregado pelo PM2.'

Write-Output '--- PM2 / apenas se daemon estiver previamente ativo ---'
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
    Write-Output 'PM2 nao encontrado; nada foi executado.'
    exit 0
}
$daemon = $false
try {
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'")) {
        if ([string]$process.CommandLine -match '(?i)(PM2[/\\].*Daemon\.js|PM2.*God Daemon|pm2[/\\]lib[/\\]Daemon)') {
            $daemon = $true
            break
        }
    }
} catch {
    Write-Output 'Nao foi possivel verificar o daemon de modo seguro.'
}
if (-not $daemon) {
    Write-Output 'Daemon PM2 nao confirmado; pm2 jlist nao sera chamado, para nao inicializar servico.'
    exit 0
}
try {
    $raw = (& pm2 jlist 2>$null | Out-String)
    $apps = @($raw | ConvertFrom-Json)
} catch {
    Write-Output 'Lista PM2 indisponivel; nenhum segredo impresso.'
    exit 0
}
Show-Safe 'Processos PM2' $apps.Count
foreach ($app in $apps) {
    Show-Safe 'Processo' ([string] $app.name)
    Show-Safe '  Status' ([string] $app.pm2_env.status)
    $cwd = [string] $app.pm2_env.pm_cwd
    if (-not [string]::IsNullOrWhiteSpace($cwd)) {
        $normalizedCwd = $cwd.TrimEnd([char[]] @([char] 92, [char] 47))
        $normalizedRoot = $root.TrimEnd([char[]] @([char] 92, [char] 47))
        Show-Safe '  Pasta corresponde ao repositorio' ([string]::Equals(
            $normalizedCwd, $normalizedRoot, [StringComparison]::OrdinalIgnoreCase
        ))
    }
    # Nunca mostrar env, argumentos, paths completos, tokens ou URLs.
    Show-Safe '  PVE_TURN_WINDOW_TTL_MS' (Flag-NumberState $app.pm2_env 'PVE_TURN_WINDOW_TTL_MS')
    Show-Safe '  PVE_MAINTENANCE_BATCH_SIZE' (Flag-NumberState $app.pm2_env 'PVE_MAINTENANCE_BATCH_SIZE')
}
Write-Output 'FIM: nenhuma instalacao, escrita, migracao, reinicio ou conexao ao DB foi feita.'
