# claude-monitor installer (Windows / PowerShell)
# ------------------------------------------------
#   irm https://raw.githubusercontent.com/Tungify/claude-monitor/main/install.ps1 | iex
#
# Downloads the latest release zip for your CPU arch, drops claude-monitor.exe
# into $env:INSTALL_DIR (default $HOME\.local\bin) and the Next.js web bundle
# into $env:SHARE_DIR (default <prefix>\share\claude-monitor), and prepends
# the bin dir to the User-scope PATH so a new shell picks it up.
#
# Override with env vars before invoking:
#   $env:INSTALL_DIR = 'C:\tools\claude-monitor\bin'
#   $env:SHARE_DIR   = 'C:\tools\claude-monitor\share\claude-monitor'
#   irm https://raw.githubusercontent.com/Tungify/claude-monitor/main/install.ps1 | iex
#
# claude-monitor talks to Windows Credential Manager directly — no
# extra deps needed. If `claude` itself works, claude-monitor will too.

$ErrorActionPreference = 'Stop'

$Repo   = 'Tungify/claude-monitor'
$Binary = 'claude-monitor'

$InstallDir = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { Join-Path $HOME '.local\bin' }
$ShareDir   = if ($env:SHARE_DIR)   { $env:SHARE_DIR   } else { Join-Path (Split-Path $InstallDir -Parent) 'share\claude-monitor' }

# ---------- arch detection ----------
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64'  { 'amd64' }
    'ARM64'  { 'arm64' }
    'x86'    { throw '32-bit Windows is not supported.' }
    default  { throw "unsupported architecture: $env:PROCESSOR_ARCHITECTURE" }
}

$target = "windows-$arch"

# ---------- resolve latest tag ----------
# Follow the redirect from /releases/latest to /releases/tag/<tag> — no API
# rate limit, no JSON parsing needed.
try {
    $head = Invoke-WebRequest -Uri "https://github.com/$Repo/releases/latest" `
                              -Method Head -MaximumRedirection 0 -UseBasicParsing `
                              -ErrorAction SilentlyContinue
    $location = $head.Headers.Location
} catch {
    # PS5 throws on 302; the response carries the redirect target.
    $location = $_.Exception.Response.Headers.Location.ToString()
}
if (-not $location) { throw "could not resolve latest release for $Repo" }
$tag = ($location -split '/')[-1]
if ($tag -notmatch '^v') { throw "could not parse release tag from $location" }

# ---------- download + extract ----------
$archive = "claude-monitor-$tag-$target.zip"
$url     = "https://github.com/$Repo/releases/download/$tag/$archive"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("claude-monitor-install-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$ProgressPreference = 'SilentlyContinue'
Write-Host "→ downloading $tag $target bundle" -ForegroundColor Blue
$zipPath = Join-Path $tmp $archive
try {
    Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
} catch {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    throw "download failed — confirm an asset exists at $url`n$_"
}

Expand-Archive -Path $zipPath -DestinationPath $tmp -Force
$extractDir = Join-Path $tmp "claude-monitor-$tag-$target"
if (-not (Test-Path $extractDir)) { throw "extracted archive missing expected directory: $extractDir" }

$srcBin = Join-Path $extractDir 'claude-monitor.exe'
$srcWeb = Join-Path $extractDir 'web'
if (-not (Test-Path $srcBin)) { throw "binary missing from archive" }
if (-not (Test-Path $srcWeb)) { throw "web bundle missing from archive" }

# ---------- install ----------
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $ShareDir   | Out-Null

$dest = Join-Path $InstallDir "$Binary.exe"
Move-Item -Force $srcBin $dest

$destWeb = Join-Path $ShareDir 'web'
if (Test-Path $destWeb) { Remove-Item -Recurse -Force $destWeb }
Move-Item -Force $srcWeb $destWeb

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

Write-Host "✓ installed $dest" -ForegroundColor Green
Write-Host "✓ installed web bundle at $destWeb" -ForegroundColor Green

# ---------- PATH wiring (User scope) ----------
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries  = if ($userPath) { $userPath -split ';' } else { @() }
if ($entries -notcontains $InstallDir) {
    $newPath = if ($userPath) { "$InstallDir;$userPath" } else { $InstallDir }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Host "✓ added $InstallDir to PATH (User scope) — open a new shell" -ForegroundColor Green
} else {
    Write-Host "→ $InstallDir already on User PATH" -ForegroundColor Blue
}

# Make the binary usable in this same session without reopening.
if (-not ($env:Path -split ';' | Where-Object { $_ -eq $InstallDir })) {
    $env:Path = "$InstallDir;$env:Path"
}

# ---------- verify ----------
Write-Host ""
Write-Host "→ verify:" -ForegroundColor Blue
& $dest --version
Write-Host ""
Write-Host "✓ done. Run: $Binary" -ForegroundColor Green
