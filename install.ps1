# claude-monitor installer (Windows / PowerShell)
# ------------------------------------------------
#   irm https://raw.githubusercontent.com/Tungify/claude-monitor/main/install.ps1 | iex
#
# Downloads the latest claude-monitor.exe for your CPU arch, drops it
# into $env:INSTALL_DIR (default $HOME\.local\bin), and prepends that
# directory to the User-scope PATH so a new shell picks it up.
#
# Override with env vars before invoking:
#   $env:INSTALL_DIR = 'C:\tools\claude-monitor'
#   irm https://raw.githubusercontent.com/Tungify/claude-monitor/main/install.ps1 | iex
#
# claude-monitor talks to Windows Credential Manager directly — no
# extra deps needed. If `claude` itself works, claude-monitor will too.

$ErrorActionPreference = 'Stop'

$Repo   = 'Tungify/claude-monitor'
$Binary = 'claude-monitor'

$InstallDir = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { Join-Path $HOME '.local\bin' }

# ---------- arch detection ----------
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64'  { 'amd64' }
    'ARM64'  { 'arm64' }
    'x86'    { throw '32-bit Windows is not supported.' }
    default  { throw "unsupported architecture: $env:PROCESSOR_ARCHITECTURE" }
}

$target = "windows-$arch"
$url    = "https://github.com/$Repo/releases/latest/download/$Binary-$target.exe"
$dest   = Join-Path $InstallDir "$Binary.exe"

# ---------- download ----------
Write-Host "→ downloading $target binary" -ForegroundColor Blue
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# Make Invoke-WebRequest fast by skipping the progress UI on PS5.
$ProgressPreference = 'SilentlyContinue'
try {
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
} catch {
    throw "download failed — confirm a release exists at https://github.com/$Repo/releases/latest`n$_"
}
Write-Host "✓ installed $dest" -ForegroundColor Green

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
