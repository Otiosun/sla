# Pokemon Beyond — preflight local, SOMENTE LEITURA
# Windows PowerShell 5.1+. Nao altera Git, arquivos, PM2, BD ou WhatsApp.
[CmdletBinding()]
param([string] $RepoPath = (Get-Location).Path)

$ErrorActionPreference = 'Stop'
$env:GIT_OPTIONAL_LOCKS = '0'

function Say([string] $Name, [object] $Value) {
    Write-Output ('{0}: {1}' -f $Name, $Value)
}

function Read-Key($Object, [string] $Key) {
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Key] }
    $property = $Object.PSObject.Properties[$Key]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Flag-State($EnvObject, [string] $Name) {
    $value = Read-Key $EnvObject $Name
    if ($null -eq $value) { return 'AUSENTE' }
    $str = [string] $value
    if ([string]::IsNullOrWhiteSpace($str)) { return 'VAZIO' }
    [long] $number = 0
    if ($str -match '^[1-9][0-9]*$' -and
        [long]::TryParse($str, [ref]$number) -and
        $number -le 9007199254740991) {
        return 'PRESENTE_INTEIRO_POSITIVO_SEGURO'
    }
    return 'PRESENTE_INVALIDO'
}

Write-Output '=== POKEMON BEYOND / PREFLIGHT LOCAL - SOMENTE LEITURA ==='
Say 'Data/hora local' (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')
Say 'PowerShell' $PSVersionTable.PSVersion.ToString()

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Output 'Git nao encontrado. Nenhuma alteracao feita.'
    exit 0
}
try {
    $root = (Resolve-Path -LiteralPath $RepoPath).Path
    $inside = (& git -C $root rev-parse --is-inside-work-tree 2>$null | Select-Object -First 1)
    if ($inside -ne 'true') { throw 'Nao e repositorio Git.' }
} catch {
    Write-Output 'Pasta invalida ou nao e repositorio Git. Nenhuma alteracao feita.'
    exit 0
}

Write-Output '--- GIT / SOMENTE LEITURA ---'
Say 'Branch local' (& git -C $root branch --show-current 2>$null | Select-Object -First 1)
Say 'Commit local' (& git -C $root rev-parse HEAD 2>$null | Select-Object -First 1)
$changes = @(& git -c core.fsmonitor=false -C $root status --porcelain=v1 --untracked-files=normal 2>$null)
Say 'Arquivos modificados/novos' $changes.Count
if ($changes.Count -gt 0) {
    Write-Output 'AVISO: preservar TODAS as alteracoes locais. Nao fazer checkout/reset/pull nesta pasta.'
}
Write-Output 'SHA do Git NAO comprova qual JS ja carregado o PM2 executa.'

Write-Output '--- PM2 / SEM REINICIAR ---'
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
    Write-Output 'PM2 nao encontrado. Nenhuma alteracao feita.'
    exit 0
}
try {
    $nodes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
    $daemons = @($nodes | Where-Object {
        $cmd = [string] $_.CommandLine
        $cmd -match '(?i)(pm2.{0,120}Daemon\.js|PM2.*God Daemon|pm2.{0,120}Daemon)'
    })
} catch {
    Write-Output 'Nao foi possivel confirmar daemon PM2 sem efeitos colaterais.'
    exit 0
}
Say 'Daemons PM2 identificados' $daemons.Count
if ($daemons.Count -eq 0) {
    Write-Output 'Daemon PM2 nao confirmado; por seguranca, nao chamar pm2 jlist.'
    exit 0
}

# jlist fornece metadados e ambiente na memoria do processo, mas NUNCA
# escrevemos o JSON bruto em disco nem mostramos seus valores/segredos.
try {
    $raw = (& pm2 jlist 2>$null | Out-String)
} catch {
    Write-Output 'PM2 respondeu com erro; nenhum dado privado exibido.'
    exit 0
}
if ([string]::IsNullOrWhiteSpace($raw)) {
    Write-Output 'PM2 jlist retornou vazio; estado do processo permanece desconhecido.'
    exit 0
}
try {
    # Windows PowerShell 5.1 ConvertFrom-Json pode falhar com chaves de
    # ambiente que diferem apenas em maiusculas/minusculas.
    # JavaScriptSerializer usa dicionarios com chaves sensiveis a caixa.
    Add-Type -AssemblyName System.Web.Extensions -ErrorAction Stop
    $decoder = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $decoder.MaxJsonLength = 67108864
    $decoder.RecursionLimit = 256
    $parsed = $decoder.DeserializeObject($raw.Trim())
    if ($parsed -isnot [System.Array]) { throw 'Formato de retorno inesperado.' }
} catch {
    Write-Output 'PM2 jlist nao pode ser interpretado nesta sessao. Nao imprimir sua saida bruta.'
    Write-Output 'Alternativa de leitura: execute pm2 status e compartilhe SOMENTE nome/status/uptime.'
    exit 0
}

Say 'Processos PM2 identificados' $parsed.Length
foreach ($app in $parsed) {
    $name = [string](Read-Key $app 'name')
    $meta = Read-Key $app 'pm2_env'
    $status = [string](Read-Key $meta 'status')
    $cwd = [string](Read-Key $meta 'pm_cwd')
    $same = [string]::Equals(
        $cwd.TrimEnd([char[]] @([char] 92, [char] 47)),
        $root.TrimEnd([char[]] @([char] 92, [char] 47)),
        [StringComparison]::OrdinalIgnoreCase
    )
    # Nao imprimir paths completos, PID, argv, env, tokens ou URLs.
    Say 'Processo PM2' $name
    Say '  Status' $status
    Say '  Pasta igual ao repositorio' $same
    Say '  PVE_TURN_WINDOW_TTL_MS' (Flag-State $meta 'PVE_TURN_WINDOW_TTL_MS')
    Say '  PVE_MAINTENANCE_BATCH_SIZE' (Flag-State $meta 'PVE_MAINTENANCE_BATCH_SIZE')
}
Write-Output 'FIM: nenhuma escrita, migracao, instalacao ou reinicio.'
