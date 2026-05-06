#!/bin/sh
#
# claude-monitor installer (macOS + Linux)
# ----------------------------------------
#   curl -fsSL https://raw.githubusercontent.com/Tungify/claude-monitor/main/install.sh | sh
#
# Downloads the latest pre-built binary for your OS/arch, drops it into
# $INSTALL_DIR (default ~/.local/bin), ad-hoc codesigns it on macOS, and
# ensures the dir is on PATH via $SHELL_RC (default ~/.zshrc).
#
# Override with env vars:
#   INSTALL_DIR=/usr/local/bin   SHELL_RC=~/.bashrc   sh install.sh
#
# Linux note: claude-monitor reads OAuth tokens via libsecret. If
# `claude` itself works on your box, libsecret is already present;
# otherwise install with `sudo apt install libsecret-tools` (Debian /
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

# ---------- libsecret check (Linux) ----------
if [ "$os" = "linux" ] && ! command -v secret-tool >/dev/null 2>&1; then
    red "✗ secret-tool not found"
    echo "   claude-monitor needs libsecret to read tokens that 'claude' stores."
    echo "   Install it first:"
    echo "     Debian/Ubuntu: sudo apt install libsecret-tools"
    echo "     Fedora:        sudo dnf install libsecret"
    echo "     Arch:          sudo pacman -S libsecret"
    exit 1
fi

# ---------- download ----------
url="https://github.com/$REPO/releases/latest/download/$BINARY-$target"
dest="$INSTALL_DIR/$BINARY"

blue "→ downloading $target binary"
mkdir -p "$INSTALL_DIR"
if ! curl -fL --progress-bar -o "$dest" "$url"; then
    die "download failed — confirm a release exists at https://github.com/$REPO/releases/latest"
fi

chmod +x "$dest"

if [ "$os" = "darwin" ]; then
    xattr -d com.apple.quarantine "$dest" 2>/dev/null || true
    codesign -f -s - "$dest" >/dev/null 2>&1 || true
fi

green "✓ installed $dest"

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
