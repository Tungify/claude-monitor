#!/bin/sh
#
# claude-monitor installer (macOS + Linux)
# ----------------------------------------
#   curl -fsSL https://raw.githubusercontent.com/Tungify/claude-monitor/main/install.sh | sh
#
# Downloads the latest release tarball for your OS/arch, extracts the
# claude-monitor binary into $INSTALL_DIR (default ~/.local/bin) and the
# Next.js web bundle into $SHARE_DIR (default <prefix>/share/claude-monitor),
# ad-hoc codesigns the binary on macOS, and ensures the bin dir is on PATH
# via $SHELL_RC (default ~/.zshrc).
#
# Override with env vars:
#   INSTALL_DIR=/usr/local/bin   SHELL_RC=~/.bashrc   sh install.sh
#   SHARE_DIR=/opt/claude-monitor sh install.sh
#
# Linux note: claude-monitor reads OAuth tokens from whichever store
# `claude` is using — libsecret (Secret Service) when available, or the
# plaintext ~/.claude/.credentials.json fallback that `claude` writes on
# headless / WSL / KDE-without-bridge setups. libsecret is recommended
# but not required; install with `sudo apt install libsecret-tools` (Debian /
# Ubuntu) or your distro's equivalent.
#
# Windows: use install.ps1 instead (PowerShell).
#
set -eu

REPO="Tungify/claude-monitor"
BINARY="claude-monitor"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
SHELL_RC="${SHELL_RC:-$HOME/.zshrc}"

red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[0;34m%s\033[0m\n' "$*"; }
die()   { red "✗ $*" >&2; exit 1; }

# ---------- platform detection ----------
case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux"  ;;
    MINGW*|MSYS*|CYGWIN*) die "Windows detected — use install.ps1 from PowerShell." ;;
    *) die "unsupported OS: $(uname -s)" ;;
esac

case "$(uname -m)" in
    arm64|aarch64)  arch="arm64" ;;
    x86_64|amd64)   arch="amd64" ;;
    *)              die "unsupported architecture: $(uname -m)" ;;
esac

target="${os}-${arch}"

# Default share dir sits next to bin/: e.g. ~/.local/bin → ~/.local/share/claude-monitor.
# This matches FindWebDir()'s `<prefix>/share/claude-monitor/web` candidate.
SHARE_DIR="${SHARE_DIR:-$(dirname "$INSTALL_DIR")/share/claude-monitor}"

# ---------- libsecret check (Linux) ----------
if [ "$os" = "linux" ] && ! command -v secret-tool >/dev/null 2>&1; then
    echo "ℹ secret-tool (libsecret) not found — falling back to ~/.claude/.credentials.json."
    echo "   If 'claude' uses the system keyring on this box, install libsecret for full feature parity:"
    echo "     Debian/Ubuntu: sudo apt install libsecret-tools"
    echo "     Fedora:        sudo dnf install libsecret"
    echo "     Arch:          sudo pacman -S libsecret"
fi

# ---------- resolve latest tag ----------
# Follow the redirect from /releases/latest to /releases/tag/<tag> instead of
# hitting the API (no rate limit, no jq dependency).
latest_url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") \
    || die "could not reach https://github.com/$REPO/releases/latest"
tag="${latest_url##*/}"
case "$tag" in
    v*) ;;
    *)  die "could not parse release tag from $latest_url" ;;
esac

# ---------- download + extract ----------
archive="claude-monitor-${tag}-${target}.tar.gz"
url="https://github.com/$REPO/releases/download/${tag}/${archive}"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT INT TERM

blue "→ downloading ${tag} ${target} bundle"
if ! curl -fL --progress-bar -o "$tmpdir/$archive" "$url"; then
    die "download failed — confirm an asset exists at $url"
fi

tar -xzf "$tmpdir/$archive" -C "$tmpdir" || die "failed to extract $archive"
extract_dir="$tmpdir/claude-monitor-${tag}-${target}"
[ -d "$extract_dir" ] || die "extracted archive missing expected directory: $extract_dir"
[ -f "$extract_dir/claude-monitor" ] || die "binary missing from archive"
[ -d "$extract_dir/web" ] || die "web bundle missing from archive"

# ---------- install ----------
mkdir -p "$INSTALL_DIR" "$SHARE_DIR"
dest="$INSTALL_DIR/$BINARY"
mv "$extract_dir/claude-monitor" "$dest"
chmod +x "$dest"

# Replace any previous web bundle atomically-ish (rm + mv).
rm -rf "$SHARE_DIR/web"
mv "$extract_dir/web" "$SHARE_DIR/web"

if [ "$os" = "darwin" ]; then
    xattr -d com.apple.quarantine "$dest" 2>/dev/null || true
    codesign -f -s - "$dest" >/dev/null 2>&1 || true
fi

green "✓ installed $dest"
green "✓ installed web bundle at $SHARE_DIR/web"

# ---------- PATH wiring ----------
case ":$PATH:" in
    *:"$INSTALL_DIR":*)
        blue "→ $INSTALL_DIR already on PATH"
        ;;
    *)
        if [ -f "$SHELL_RC" ] && grep -qF "$INSTALL_DIR" "$SHELL_RC" 2>/dev/null; then
            blue "→ $SHELL_RC already references $INSTALL_DIR — open a new shell"
        else
            printf '\n# claude-monitor\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >> "$SHELL_RC"
            green "✓ added $INSTALL_DIR to PATH in $SHELL_RC"
            blue "→ run: exec \$SHELL -l    (or open a new terminal)"
        fi
        ;;
esac

# ---------- verify ----------
echo
blue "→ verify:"
"$dest" --version
echo
green "✓ done. Run: $BINARY"
