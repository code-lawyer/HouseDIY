param(
  [Parameter(Mandatory = $true)]
  [string]$CandidateExe,
  [string]$Sha256File,
  [string]$ExpectedSha256,
  [string]$ProgramDir = (Join-Path $env:LOCALAPPDATA 'Programs\HouseDIY'),
  [string]$ShortcutPath = (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'HouseDIY.lnk'),
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'

function Get-Fingerprint([string]$Path) {
  (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Assert-NotReparsePoint([string]$Path) {
  while ($Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Unexpected linked item in installation or workspace path: $Path"
    }
    $Path = [IO.Path]::GetDirectoryName($Path)
  }
}

function Resolve-WorkspaceDir() {
  if ($env:HOUSEDIY_DATA_DIR) { return (Join-Path $env:HOUSEDIY_DATA_DIR 'workspace') }
  if ($env:MYHOUSE_DATA_DIR) { return (Join-Path $env:MYHOUSE_DATA_DIR 'workspace') }
  $appData = [Environment]::GetFolderPath('ApplicationData')
  $defaultWs = Join-Path $appData 'HouseDIY\workspace'
  $legacyWs = Join-Path $appData 'MyHouse\workspace'
  foreach ($ws in @($defaultWs, $legacyWs)) {
    $projects = Join-Path $ws 'projects'
    if ((Test-Path -LiteralPath (Join-Path $ws 'workspace-initialized.json')) -or
        ((Test-Path -LiteralPath $projects) -and @(Get-ChildItem -LiteralPath $projects -Filter '*.json').Count -gt 0)) {
      return $ws
    }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $defaultWs 'settings.json')) -and
      (Test-Path -LiteralPath (Join-Path $legacyWs 'settings.json'))) {
    return $legacyWs
  }
  return $defaultWs
}

function Get-WorkspaceFiles([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  foreach ($item in Get-ChildItem -LiteralPath $Path -Recurse -Force) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Unexpected linked item in workspace: $($item.FullName)"
    }
    if (-not $item.PSIsContainer) {
      [pscustomobject]@{
        Path = $item.FullName.Substring($Path.TrimEnd('\').Length + 1)
        Size = $item.Length
        SHA256 = Get-Fingerprint $item.FullName
      }
    }
  }
}

$resolvedCandidate = (Resolve-Path -LiteralPath $CandidateExe).Path
$newName = Split-Path -Leaf $resolvedCandidate
if ([IO.Path]::GetExtension($newName) -ne '.exe') { throw 'Select the portable .exe file' }
$ProgramDir = [IO.Path]::GetFullPath($ProgramDir)
$ShortcutPath = [IO.Path]::GetFullPath($ShortcutPath)
if ([IO.Path]::GetExtension($ShortcutPath) -ne '.lnk') { throw 'Select a .lnk shortcut path' }
$releaseHash = if ($ExpectedSha256) {
  $ExpectedSha256.Trim().ToLowerInvariant()
} elseif ($Sha256File) {
  ((Get-Content -Raw -LiteralPath $Sha256File).Trim() -split '\s+')[0].ToLowerInvariant()
} else {
  $autoShaFile = [IO.Path]::ChangeExtension($resolvedCandidate, '.sha256')
  if (Test-Path -LiteralPath $autoShaFile) {
    ((Get-Content -Raw -LiteralPath $autoShaFile).Trim() -split '\s+')[0].ToLowerInvariant()
  } else {
    throw 'Supply the release .sha256 file or -ExpectedSha256 to verify the executable'
  }
}

if ($releaseHash -notmatch '^[0-9a-f]{64}$' -or (Get-Fingerprint $resolvedCandidate) -ne $releaseHash) {
  throw 'Candidate executable does not match the expected SHA-256 checksum'
}

$workspace = [IO.Path]::GetFullPath((Resolve-WorkspaceDir))
$workspacePrefix = $workspace.TrimEnd('\') + '\'
foreach ($destination in @($ProgramDir, $ShortcutPath)) {
  if (($destination.TrimEnd('\') + '\').StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Installation and shortcut paths must be outside the workspace'
  }
}
foreach ($path in @($ProgramDir, $ShortcutPath, $workspace)) {
  Assert-NotReparsePoint $path
}

if (@(Get-Process -Name 'HouseDIY', 'MyHouse' -ErrorAction SilentlyContinue).Count) {
  throw 'Save your work and close HouseDIY before upgrading'
}

[void](New-Item -ItemType Directory -Path $ProgramDir -Force)
$newExe = Join-Path $ProgramDir $newName
Assert-NotReparsePoint $newExe
$backupFolder = Join-Path $ProgramDir ('rollback-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
[void](New-Item -ItemType Directory -Path $backupFolder)

$manifest = @(Get-WorkspaceFiles $workspace)
if (Test-Path -LiteralPath $workspace) {
  $backupWorkspace = Join-Path $backupFolder 'workspace'
  Copy-Item -LiteralPath $workspace -Destination $backupWorkspace -Recurse -Force
  $backupManifest = @(Get-WorkspaceFiles $backupWorkspace)
  if (Compare-Object -ReferenceObject $manifest -DifferenceObject $backupManifest -Property Path, Size, SHA256) {
    throw 'Workspace backup verification failed'
  }
}

if (-not (Test-Path -LiteralPath $newExe)) {
  $stage = Join-Path $ProgramDir ('.install-housediy-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  try {
    Copy-Item -LiteralPath $resolvedCandidate -Destination $stage
    if ((Get-Fingerprint $stage) -ne $releaseHash) {
      throw 'Staged executable failed checksum verification'
    }
    Move-Item -LiteralPath $stage -Destination $newExe
  } finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Force }
  }
} elseif ((Get-Fingerprint $newExe) -ne $releaseHash) {
  throw "Existing file at $newExe has a different SHA-256 checksum"
}

$shell = New-Object -ComObject WScript.Shell
$backupShortcut = Join-Path $backupFolder 'HouseDIY.lnk'
$stagedShortcut = Join-Path (Split-Path -Parent $ShortcutPath) ('.housediy-upgrade-' + [Guid]::NewGuid().ToString('N') + '.lnk')
try {
  $arguments = ''
  if (Test-Path -LiteralPath $ShortcutPath) {
    Copy-Item -LiteralPath $ShortcutPath -Destination $stagedShortcut
    $arguments = $shell.CreateShortcut($ShortcutPath).Arguments
  }
  $newLink = $shell.CreateShortcut($stagedShortcut)
  $newLink.TargetPath = $newExe
  $newLink.WorkingDirectory = $ProgramDir
  $newLink.Arguments = $arguments
  $newLink.IconLocation = "$newExe,0"
  $newLink.Save()
  if (Test-Path -LiteralPath $ShortcutPath) {
    [IO.File]::Replace($stagedShortcut, $ShortcutPath, $backupShortcut)
  } else {
    Move-Item -LiteralPath $stagedShortcut -Destination $ShortcutPath
  }
} finally {
  if (Test-Path -LiteralPath $stagedShortcut) { Remove-Item -LiteralPath $stagedShortcut -Force }
}

$receipt = [pscustomobject]@{
  installedAt = (Get-Date).ToString('o')
  installed = $newExe
  sha256 = $releaseHash
  shortcut = $ShortcutPath
  workspace = $workspace
  backedUpFiles = $manifest.Count
  backup = $backupFolder
}
$receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $backupFolder 'install-receipt.json') -Encoding utf8

if (-not $NoLaunch) {
  Start-Process -FilePath $ShortcutPath
}
$receipt | ConvertTo-Json -Compress
