// Package update implements the in-app self-upgrade flow: it talks to
// GitHub Releases, downloads the right release archive for the host,
// extracts the binary + web bundle, and swaps them into place.
// Restart of the running process lives in restart_unix.go /
// restart_windows.go.
package update

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"claude-monitor/internal/format"
)

const githubReleasesAPI = "https://api.github.com/repos/Tungify/claude-monitor/releases/latest"

// Info describes a published release that's strictly newer than the
// running binary. Returned by Check; nil means "you're on the latest"
// (or the check failed silently).
type Info struct {
	LatestTag   string
	DownloadURL string
	AssetName   string
	Body        string
}

type ghRelease struct {
	TagName string `json:"tag_name"`
	Body    string `json:"body"`
	Assets  []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
	} `json:"assets"`
}

// Check hits the GitHub Releases API and returns a non-nil Info when
// the latest tag is newer than current. The check fires asynchronously
// from the TUI's Init, so the network round-trip never blocks startup;
// failures (offline, rate-limited, GitHub down) are reported back to
// the caller but the TUI treats them as "no banner" to keep the
// dashboard quiet on a flaky network.
//
// We deliberately don't cache here. The dashboard is a long-running
// TUI that gets launched once or twice a day per user, so a single
// API call per launch sits comfortably under GitHub's 60 req/hour
// anonymous limit and removes the surprising "I just shipped a release
// but the banner won't show for hours" behavior we had with caching.
func Check(ctx context.Context, currentVersion string) (*Info, error) {
	info, err := FetchLatest(ctx)
	if err != nil {
		return nil, err
	}
	if IsNewer(info.LatestTag, currentVersion) {
		return info, nil
	}
	return nil, nil
}

// FetchLatest returns the latest release's Info regardless of whether
// it's newer than the running version. Used by the `--upgrade` CLI
// path so it can print "already on latest" rather than a no-op.
//
// The asset we look for is the bundled archive published by
// .github/workflows/release.yml: claude-monitor-<tag>-<os>-<arch>.tar.gz
// on posix, .zip on windows. Extraction + binary/web swap lives in
// Perform.
func FetchLatest(ctx context.Context) (*Info, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, githubReleasesAPI, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "claude-monitor")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, format.Truncate(string(body), 200))
	}
	var rel ghRelease
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return nil, fmt.Errorf("decode release: %w", err)
	}
	target := assetName(rel.TagName)
	for _, a := range rel.Assets {
		if a.Name == target {
			return &Info{
				LatestTag:   rel.TagName,
				DownloadURL: a.BrowserDownloadURL,
				AssetName:   a.Name,
				Body:        rel.Body,
			}, nil
		}
	}
	return nil, fmt.Errorf("no asset %q in release %s", target, rel.TagName)
}

// assetName returns the release-archive name for the host platform at
// a given tag, mirroring the layout produced by release.yml.
func assetName(tag string) string {
	ext := ".tar.gz"
	if runtime.GOOS == "windows" {
		ext = ".zip"
	}
	return fmt.Sprintf("claude-monitor-%s-%s-%s%s", tag, runtime.GOOS, runtime.GOARCH, ext)
}

// IsNewer compares two semver-ish strings (with or without a leading
// "v") numerically per dotted component. A non-numeric current
// version (e.g. "dev" from an untagged build) is treated as older
// than any released tag, so dev builds get nudged toward an actual
// release.
func IsNewer(latest, current string) bool {
	cur := normalizeVersion(current)
	next := normalizeVersion(latest)
	if next == "" {
		return false
	}
	if cur == "" {
		return true
	}
	return compareDottedVersions(next, cur) > 0
}

func normalizeVersion(v string) string {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	for i, c := range v {
		if c != '.' && (c < '0' || c > '9') {
			return v[:i]
		}
	}
	return v
}

func compareDottedVersions(a, b string) int {
	aParts := strings.Split(a, ".")
	bParts := strings.Split(b, ".")
	n := len(aParts)
	if len(bParts) > n {
		n = len(bParts)
	}
	for i := 0; i < n; i++ {
		var ai, bi int
		if i < len(aParts) {
			ai, _ = strconv.Atoi(aParts[i])
		}
		if i < len(bParts) {
			bi, _ = strconv.Atoi(bParts[i])
		}
		if ai != bi {
			if ai > bi {
				return 1
			}
			return -1
		}
	}
	return 0
}

// Perform downloads info.DownloadURL next to the running executable,
// extracts the bundled archive, ad-hoc codesigns the new binary on
// darwin, and swaps both the binary and the web/ folder into place.
// The currently-running process keeps executing from its already-mapped
// pages; the next invocation picks up the new binary.
//
// Replacement strategy:
//
//   - Binary: a single os.Rename on darwin/linux works because Unix
//     opens-by-inode keep the running text mapping live. Windows moves
//     the running .exe aside to <exe>.old first since a running .exe
//     is locked, and CleanupStaleArtifacts removes <exe>.old on next
//     launch.
//   - web/: the new bundle is staged at <binDir>/web.new, the existing
//     web/ is moved aside to web.old, then web.new takes its place.
//     CleanupStaleArtifacts removes web.old on next launch. If the
//     archive doesn't carry a web/ folder (e.g. an older release
//     format), the existing web/ is left untouched.
//
// Skipped when the running process can't write to its own directory
// (e.g. installed under /usr/local/bin without sudo / Program Files
// without admin). In that case we surface a clear error so the user
// can re-run the appropriate installer manually.
func Perform(ctx context.Context, info *Info) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate self: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	binDir := filepath.Dir(exe)

	dl := exe + ".dl"
	unpack := exe + ".unpack"
	_ = os.Remove(dl)
	_ = os.RemoveAll(unpack)
	defer func() {
		_ = os.Remove(dl)
		_ = os.RemoveAll(unpack)
	}()

	if err := downloadToFile(ctx, info.DownloadURL, dl); err != nil {
		return err
	}
	if err := os.MkdirAll(unpack, 0o755); err != nil {
		return fmt.Errorf("mkdir unpack: %w", err)
	}
	if strings.HasSuffix(info.AssetName, ".zip") {
		if err := extractZip(dl, unpack); err != nil {
			return fmt.Errorf("extract zip: %w", err)
		}
	} else {
		if err := extractTarGz(dl, unpack); err != nil {
			return fmt.Errorf("extract tar.gz: %w", err)
		}
	}

	innerDir, err := singleTopLevelDir(unpack)
	if err != nil {
		return fmt.Errorf("locate archive contents: %w", err)
	}

	binName := "claude-monitor"
	if runtime.GOOS == "windows" {
		binName += ".exe"
	}
	newBin := filepath.Join(innerDir, binName)
	if _, err := os.Stat(newBin); err != nil {
		return fmt.Errorf("archive missing %s: %w", binName, err)
	}

	tmp := exe + ".new"
	_ = os.Remove(tmp)
	if err := os.Rename(newBin, tmp); err != nil {
		return fmt.Errorf("stage new binary: %w", err)
	}
	if err := os.Chmod(tmp, 0o755); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("chmod: %w", err)
	}

	if runtime.GOOS == "darwin" {
		_ = exec.Command("xattr", "-d", "com.apple.quarantine", tmp).Run()
		if out, err := exec.Command("codesign", "-f", "-s", "-", tmp).CombinedOutput(); err != nil {
			_ = os.Remove(tmp)
			return fmt.Errorf("codesign: %w (%s)", err, strings.TrimSpace(string(out)))
		}
	}

	// Stage the new web bundle alongside the binary BEFORE swapping
	// the binary. Skip when the archive doesn't ship one; older
	// upgrade flows didn't and we don't want to delete a usable
	// existing bundle.
	newWeb := filepath.Join(innerDir, "web")
	webStaged := ""
	if st, err := os.Stat(newWeb); err == nil && st.IsDir() {
		webStaged = filepath.Join(binDir, "web.new")
		_ = os.RemoveAll(webStaged)
		if err := os.Rename(newWeb, webStaged); err != nil {
			_ = os.Remove(tmp)
			return fmt.Errorf("stage new web bundle: %w", err)
		}
	}

	if runtime.GOOS == "windows" {
		old := exe + ".old"
		_ = os.Remove(old)
		if err := os.Rename(exe, old); err != nil {
			_ = os.Remove(tmp)
			_ = os.RemoveAll(webStaged)
			return fmt.Errorf("move running binary aside: %w", err)
		}
		if err := os.Rename(tmp, exe); err != nil {
			_ = os.Rename(old, exe) // best-effort restore
			_ = os.RemoveAll(webStaged)
			return fmt.Errorf("install new binary: %w", err)
		}
	} else {
		if err := os.Rename(tmp, exe); err != nil {
			_ = os.Remove(tmp)
			_ = os.RemoveAll(webStaged)
			return fmt.Errorf("replace binary: %w (try re-running the installer)", err)
		}
	}

	if webStaged != "" {
		webDest := filepath.Join(binDir, "web")
		webOld := filepath.Join(binDir, "web.old")
		_ = os.RemoveAll(webOld)
		if _, err := os.Stat(webDest); err == nil {
			if err := os.Rename(webDest, webOld); err != nil {
				return fmt.Errorf("move existing web/ aside: %w", err)
			}
		}
		if err := os.Rename(webStaged, webDest); err != nil {
			// Best-effort restore so the binary keeps a usable bundle.
			_ = os.Rename(webOld, webDest)
			return fmt.Errorf("install new web bundle: %w", err)
		}
	}

	return nil
}

// CleanupStaleArtifacts removes leftover upgrade temporaries from
// prior runs (binary <exe>.old/.new/.dl/.unpack and bundle
// <binDir>/web.old/web.new), plus the legacy update-check.json cache
// file we no longer write. Called once at startup; best-effort, any
// permission error is swallowed because it's non-essential.
func CleanupStaleArtifacts() {
	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		binDir := filepath.Dir(exe)
		_ = os.Remove(exe + ".old")
		_ = os.Remove(exe + ".new")
		_ = os.Remove(exe + ".dl")
		_ = os.RemoveAll(exe + ".unpack")
		_ = os.RemoveAll(filepath.Join(binDir, "web.old"))
		_ = os.RemoveAll(filepath.Join(binDir, "web.new"))
	}
	if home, err := os.UserHomeDir(); err == nil {
		_ = os.Remove(filepath.Join(home, ".claude-monitor", "update-check.json"))
	}
}

func downloadToFile(ctx context.Context, url, dest string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "claude-monitor")
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download HTTP %d", resp.StatusCode)
	}
	f, err := os.Create(dest)
	if err != nil {
		return fmt.Errorf("create %s: %w", dest, err)
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		_ = f.Close()
		return fmt.Errorf("write %s: %w", dest, err)
	}
	return f.Close()
}

// singleTopLevelDir returns the path of the single child directory
// inside dir if there is exactly one (and it's a directory).
// Otherwise returns dir itself. Release tarballs ship as one wrapper
// directory (claude-monitor-vX.Y.Z-os-arch/) so this collapses that
// wrapper without baking the version into the lookup.
func singleTopLevelDir(dir string) (string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	if len(entries) == 1 && entries[0].IsDir() {
		return filepath.Join(dir, entries[0].Name()), nil
	}
	return dir, nil
}

// extractTarGz extracts src into dest. Refuses entries whose normalized
// path escapes dest (zip-slip).
func extractTarGz(src, dest string) error {
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		path, err := safeJoin(dest, hdr.Name)
		if err != nil {
			return err
		}
		mode := os.FileMode(hdr.Mode & 0o7777)
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(path, mode|0o700); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				return err
			}
			out, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode|0o600)
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, tr); err != nil {
				_ = out.Close()
				return err
			}
			if err := out.Close(); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				return err
			}
			// Reject symlinks whose literal target would escape dest.
			// We don't try to resolve filesystem walks — a tarball
			// containing "../../etc/passwd" is rejected outright.
			if _, err := safeJoin(filepath.Dir(path), hdr.Linkname); err != nil {
				return err
			}
			_ = os.Remove(path)
			if err := os.Symlink(hdr.Linkname, path); err != nil {
				return err
			}
		default:
			// Skip char/block/fifo/etc. — not used by our bundles.
		}
	}
}

// extractZip extracts src into dest with the same zip-slip protection
// as extractTarGz.
func extractZip(src, dest string) error {
	r, err := zip.OpenReader(src)
	if err != nil {
		return err
	}
	defer r.Close()
	for _, f := range r.File {
		path, err := safeJoin(dest, f.Name)
		if err != nil {
			return err
		}
		mode := f.Mode()
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(path, mode|0o700); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode|0o600)
		if err != nil {
			_ = rc.Close()
			return err
		}
		if _, err := io.Copy(out, rc); err != nil {
			_ = rc.Close()
			_ = out.Close()
			return err
		}
		_ = rc.Close()
		if err := out.Close(); err != nil {
			return err
		}
	}
	return nil
}

// safeJoin returns filepath.Join(base, name) but errors when name
// traverses outside base. Backslashes in archive entry names are
// normalized to forward slashes so a windows-style path can't sneak
// past on linux/darwin.
func safeJoin(base, name string) (string, error) {
	clean := filepath.Clean(strings.ReplaceAll(name, "\\", "/"))
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("archive entry escapes target dir: %q", name)
	}
	dest := filepath.Join(base, clean)
	rel, err := filepath.Rel(base, dest)
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("archive entry escapes target dir: %q", name)
	}
	return dest, nil
}
