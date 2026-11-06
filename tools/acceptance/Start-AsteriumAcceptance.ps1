param(
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$')][string]$Batch,
    [Parameter(Mandatory = $true)][ValidateRange(1024, 65535)][int]$Port,
    [string]$DataDirectory,
    [switch]$BackgroundServices,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
# Pin this process to its own existing utility module, regardless of inherited PSModulePath.
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Force -ErrorAction Stop

function Assert-NoDirectoryLinks([string]$Directory) {
    $cursor = [System.IO.Path]::GetFullPath($Directory)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                throw 'ASTERIUM_ACCEPTANCE_LINKED_DIRECTORY'
            }
            $marker = Join-Path $cursor '.asterium-profile.v1.json'
            if (Test-Path -LiteralPath $marker) {
                $ownerFile = Get-Item -LiteralPath $marker -Force
                if ($ownerFile.PSIsContainer -or ($ownerFile.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or $ownerFile.Length -gt 4096) {
                    throw 'ASTERIUM_ACCEPTANCE_MARKER_INVALID'
                }
                $owner = Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($owner.version -ne 1 -or $owner.profile -ne 'acceptance') { throw 'ASTERIUM_ACCEPTANCE_OWNER_MISMATCH' }
            }
        }
        $parent = [System.IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
}

if (-not [System.IO.Path]::IsPathRooted($ExecutablePath)) { throw 'ASTERIUM_ACCEPTANCE_ABSOLUTE_EXE_REQUIRED' }
$candidate = Get-Item -LiteralPath $ExecutablePath -Force
if ($candidate.PSIsContainer -or $candidate.Name -ine 'Asterium.exe' -or ($candidate.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'ASTERIUM_ACCEPTANCE_UNPACKED_EXE_REQUIRED'
}
if (-not $DataDirectory) {
    if (-not $env:LOCALAPPDATA) { throw 'ASTERIUM_ACCEPTANCE_LOCALAPPDATA_REQUIRED' }
    $DataDirectory = Join-Path (Join-Path $env:LOCALAPPDATA 'Asterium-Test') $Batch
}
if (-not [System.IO.Path]::IsPathRooted($DataDirectory)) { throw 'ASTERIUM_ACCEPTANCE_ABSOLUTE_DATA_REQUIRED' }
$data = [System.IO.Path]::GetFullPath($DataDirectory).TrimEnd([char[]]'\/')
if (-not $data -or $data -eq [System.IO.Path]::GetPathRoot($data).TrimEnd([char[]]'\/')) { throw 'ASTERIUM_ACCEPTANCE_DATA_ROOT_REJECTED' }
Assert-NoDirectoryLinks $data
if (Test-Path -LiteralPath $data) {
    $marker = Join-Path $data '.asterium-profile.v1.json'
    if (-not (Test-Path -LiteralPath $marker) -and @(Get-ChildItem -LiteralPath $data -Force).Count -gt 0) {
        throw 'ASTERIUM_ACCEPTANCE_UNCLAIMED_DIRECTORY'
    }
}

# Quoted as complete Windows arguments; paths cannot contain a literal quote.
if ($data.Contains('"')) { throw 'ASTERIUM_ACCEPTANCE_INVALID_PATH' }
$launchArgs = @('--asterium-profile=acceptance', "--asterium-acceptance-batch=$Batch", "--asterium-mcp-port=$Port", "--user-data-dir=$data")
if ($BackgroundServices) { $launchArgs += '--asterium-background-services' }
$receipt = [ordered]@{
    launcherVersion = 1
    profile = 'acceptance'
    batch = $Batch
    port = $Port
    executable = $candidate.FullName
    executableSha256 = (Get-FileHash -LiteralPath $candidate.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    dataDirectory = $data
    arguments = $launchArgs
    dryRun = [bool]$DryRun
}
if (-not $DryRun) {
    $quotedArgs = ($launchArgs | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $process = Start-Process -FilePath $candidate.FullName -ArgumentList $quotedArgs -WorkingDirectory $candidate.DirectoryName -WindowStyle Hidden -PassThru
    $receipt['processId'] = $process.Id
}
$receipt | ConvertTo-Json -Depth 4 -Compress
