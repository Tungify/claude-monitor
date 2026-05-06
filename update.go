package main

import (
	"context"
	"encoding/json"
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
)

const githubReleasesAPI = "https://api.github.com/repos/Tungify/claude-monitor/releases/latest"

// UpdateInfo describes a published release that's strictly newer than
// the running binary. Returned by CheckForUpdate; nil means "you're on
// the latest" (or the check failed silently).
type UpdateInfo struct {
	LatestTag   string
	DownloadURL string
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

// CheckForUpdate hits the GitHub Releases API and returns a non-nil
// UpdateInfo when the latest tag is newer than current. The check fires
// asynchronously from the TUI's Init, so the network round-trip never
// blocks startup; failures (offline, rate-limited, GitHub down) are
// reported back to the caller but the TUI treats them as "no banner"
// to keep the dashboard quiet on a flaky network.
//
// We deliberately don't cache here. The dashboard is a long-running
// TUI that gets launched once or twice a day per user, so a single
// API call per launch sits comfortably under GitHub's 60 req/hour
// anonymous limit and removes the surprising "I just shipped a release
// but the banner won't show for hours" behavior we had with caching.
func CheckForUpdate(ctx context.Context, currentVersion string) (*UpdateInfo, error) {
	info, err := fetchLatestRelease(ctx)
	if err != nil {
		return nil, err
	}
	if isNewerVersion(info.LatestTag, currentVersion) {
		return info, nil
	}
	return nil, nil
}

func fetchLatestRelease(ctx context.Context) (*UpdateInfo, error) {
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
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	var rel ghRelease
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return nil, fmt.Errorf("decode release: %w", err)
	}
	target := fmt.Sprintf("claude-monitor-%s-%s", runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS == "windows" {
		target += ".exe"
	}
	for _, a := range rel.Assets {
		if a.Name == target {
			return &UpdateInfo{
				LatestTag:   rel.TagName,
				DownloadURL: a.BrowserDownloadURL,
				Body:        rel.Body,
			}, nil
		}
	}
	return nil, fmt.Errorf("no asset %q in release %s", target, rel.TagName)
}

// isNewerVersion compares two semver-ish strings (with or without a
// leading "v") numerically per dotted component. A non-numeric current
// version (e.g. "dev" from an untagged build) is treated as older than
// any released tag, so dev builds get nudged toward an actual release.
func isNewerVersion(latest, current string) bool {
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

// PerformUpgrade downloads info.DownloadURL next to the running
// executable, ad-hoc codesigns it on darwin, and replaces the original.
// The currently-running process keeps executing from its already-mapped
// pages; the next invocation picks up the new binary.
//
// Replacement strategy is OS-sensitive:
//
//   - darwin/linux: a single os.Rename over the running binary works
//     because Unix opens-by-inode keep the running text mapping live.
//   - windows: a running .exe is locked, so we move it aside to
//     `<exe>.old` first, then rename the new file into place. The .old
//     file is removed by cleanupStaleUpgradeArtifacts on next launch.
//
// Skipped when the running process can't write to its own directory
// (e.g. installed under /usr/local/bin without sudo / Program Files
// without admin). In that case we surface a clear error so the user
// can re-run the appropriate installer manually.
func PerformUpgrade(ctx context.Context, info *UpdateInfo) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate self: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}

	tmp := exe + ".new"
	if err := downloadToFile(ctx, info.DownloadURL, tmp); err != nil {
		_ = os.Remove(tmp)
		return err
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

	if runtime.GOOS == "windows" {
		old := exe + ".old"
		_ = os.Remove(old)
		if err := os.Rename(exe, old); err != nil {
			_ = os.Remove(tmp)
			return fmt.Errorf("move running binary aside: %w", err)
		}
		if err := os.Rename(tmp, exe); err != nil {
			_ = os.Rename(old, exe) // best-effort restore
			return fmt.Errorf("install new binary: %w", err)
		}
	} else {
		if err := os.Rename(tmp, exe); err != nil {
			_ = os.Remove(tmp)
			return fmt.Errorf("replace binary: %w (try re-running the installer)", err)
		}
	}

	return nil
}

// cleanupStaleUpgradeArtifacts removes leftover <exe>.old / <exe>.new
// files from prior upgrades, plus the legacy update-check.json cache
// file we no longer write. Called once at startup; best-effort, any
// permission error is swallowed because it's non-essential.
func cleanupStaleUpgradeArtifacts() {
	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		_ = os.Remove(exe + ".old")
		_ = os.Remove(exe + ".new")
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
