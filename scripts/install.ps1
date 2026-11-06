# FrankenTTY installer for Windows (PowerShell 5.1 and 7).
#
#   irm https://github.com/iant4093/FrankenTTY/releases/latest/download/install.ps1 | iex
#   powershell -File install.ps1 [-Yes] [-NoFfmpeg]
#
# Environment:
#   FRANKENTTY_RELEASE_BASE  where the zip and SHA256SUMS live (default: latest GitHub release;
#                            file:// URLs are copied from disk, which the tests use)
#   FRANKENTTY_INSTALL_DIR   target directory (default: %LOCALAPPDATA%\Programs\FrankenTTY)
#   FRANKENTTY_YES=1         same as -Yes (use this form with `irm | iex`)
#   FRANKENTTY_NO_FFMPEG=1   same as -NoFfmpeg
#
# Installs one exe into the user's directory and the user PATH. Needs no administrator rights.
param(
  [switch]$Yes,
  [switch]$NoFfmpeg
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Get-FrankenttyFile {
  param([string]$Url, [string]$Destination)
  if ($Url -like 'file://*') {
    Copy-Item -LiteralPath ([Uri]$Url).LocalPath -Destination $Destination -Force
  } else {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
  }
}

function Install-Frankentty {
  param([bool]$AssumeYes, [bool]$SkipFfmpeg)

  # Windows PowerShell 5.1 may default to TLS 1.0/1.1, which GitHub rejects.
  try {
    [Net.ServicePointManager]::SecurityProtocol =
      [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch { }

  $base = $env:FRANKENTTY_RELEASE_BASE
  if (-not $base) { $base = 'https://github.com/iant4093/FrankenTTY/releases/latest/download' }
  $base = $base.TrimEnd('/')

  $installDir = $env:FRANKENTTY_INSTALL_DIR
  if (-not $installDir) { $installDir = Join-Path $env:LOCALAPPDATA 'Programs\FrankenTTY' }

  $arch = $env:PROCESSOR_ARCHITEW6432
  if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
  switch ($arch) {
    'AMD64' { }
    'ARM64' { Write-Host 'Windows on ARM64 detected. Using the x64 build, which runs under emulation.' }
    default { throw "unsupported CPU architecture: $arch (supported: x64)" }
  }

  $archive = 'frankentty-windows-x64.zip'
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('frankentty-install-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Write-Host 'Installing FrankenTTY for windows-x64'
    Get-FrankenttyFile -Url "$base/$archive" -Destination (Join-Path $tmp $archive)
    Get-FrankenttyFile -Url "$base/SHA256SUMS" -Destination (Join-Path $tmp 'SHA256SUMS')

    $expected = $null
    foreach ($line in (Get-Content -LiteralPath (Join-Path $tmp 'SHA256SUMS'))) {
      $parts = $line.Trim() -split '\s+', 2
      if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $archive) {
        $expected = $parts[0].ToLowerInvariant()
        break
      }
    }
    if (-not $expected) { throw "SHA256SUMS has no entry for $archive" }
    $actual = (Get-FileHash -LiteralPath (Join-Path $tmp $archive) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      throw "checksum mismatch for $archive (expected $expected, got $actual). Nothing was installed."
    }
    Write-Host 'Checksum verified.'

    $extract = Join-Path $tmp 'extract'
    Expand-Archive -LiteralPath (Join-Path $tmp $archive) -DestinationPath $extract -Force
    $exe = Join-Path $extract 'frankentty.exe'
    if (-not (Test-Path -LiteralPath $exe)) { throw "$archive does not contain frankentty.exe" }

    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    $staged = Join-Path $installDir ('.frankentty-' + [Guid]::NewGuid().ToString('N') + '.exe')
    $target = Join-Path $installDir 'frankentty.exe'
    try {
      Copy-Item -LiteralPath $exe -Destination $staged -Force
      Move-Item -LiteralPath $staged -Destination $target -Force
    } catch {
      Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
      throw "cannot install to $target. Close any running frankentty and try again. ($($_.Exception.Message))"
    }
    Write-Host "Installed $target"
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }

  # User PATH (persistent) and this session.
  $normalized = $installDir.TrimEnd('\')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $userEntries = @()
  if ($userPath) { $userEntries = $userPath -split ';' | Where-Object { $_ } }
  $inUserPath = $false
  foreach ($entry in $userEntries) {
    if ($entry.TrimEnd('\') -ieq $normalized) { $inUserPath = $true }
  }
  if (-not $inUserPath) {
    $newPath = if ($userPath) { $userPath.TrimEnd(';') + ';' + $installDir } else { $installDir }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Host "Added $installDir to your user PATH."
  }
  $inSession = $false
  foreach ($entry in ($env:Path -split ';')) {
    if ($entry -and $entry.TrimEnd('\') -ieq $normalized) { $inSession = $true }
  }
  if (-not $inSession) { $env:Path = $installDir + ';' + $env:Path }

  if (-not $SkipFfmpeg) {
    $missing = @()
    foreach ($tool in 'ffmpeg', 'ffprobe', 'ffplay') {
      if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { $missing += $tool }
    }
    if ($missing.Count -eq 0) {
      Write-Host 'FFmpeg found (ffmpeg, ffprobe, ffplay).'
    } else {
      Write-Host ''
      Write-Host ('FrankenTTY needs FFmpeg. Missing: ' + ($missing -join ' '))
      Write-Host 'Install command: winget install --id Gyan.FFmpeg -e'
      $winget = Get-Command winget -ErrorAction SilentlyContinue
      if (-not $winget) {
        Write-Host 'winget was not found. Install FFmpeg from https://ffmpeg.org/download.html'
      } else {
        $answer = 'n'
        if ($AssumeYes) {
          $answer = 'y'
        } else {
          try { $answer = Read-Host 'Install FFmpeg now? [y/N]' } catch { $answer = 'n' }
        }
        if ($answer -match '^(y|yes)$') {
          & winget install --id Gyan.FFmpeg -e
          if ($LASTEXITCODE -eq 0) {
            Write-Host 'FFmpeg installed. Open a new terminal so it is on PATH.'
          } else {
            Write-Host 'FFmpeg install failed. Run this yourself: winget install --id Gyan.FFmpeg -e'
          }
        } else {
          Write-Host 'Skipped. Run this when you are ready: winget install --id Gyan.FFmpeg -e'
        }
      }
    }
  }

  Write-Host ''
  Write-Host "Uninstall: Remove-Item `"$installDir\frankentty.exe`""
  Write-Host 'Run: frankentty --demo   (open a new terminal first if the command is not found)'
}

$assumeYes = [bool]$Yes -or ($env:FRANKENTTY_YES -eq '1')
$skipFfmpeg = [bool]$NoFfmpeg -or ($env:FRANKENTTY_NO_FFMPEG -eq '1')
try {
  Install-Frankentty -AssumeYes $assumeYes -SkipFfmpeg $skipFfmpeg
} catch {
  [Console]::Error.WriteLine("frankentty install: $($_.Exception.Message)")
  # `exit` would close the user's window under `irm | iex`; only exit when run as a file.
  if ($PSCommandPath) { exit 1 }
}
