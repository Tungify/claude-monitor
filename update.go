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

const (
	githubReleasesAPI = "https://api.github.com/repos/Tungify/claude-monitor/releases/latest"
	updateCacheTTL    = 24 * time.Hour
)

// UpdateInfo describes a published release that's strictly newer than
// the running binary. Returned by CheckForUpdate; nil means "you're on
// the latest" (or the check failed silently).
type UpdateInfo struct {
	LatestTag   string
	DownloadURL string
	Body        string
}

type updateCache struct {
	CheckedAt   time.Time `json:"checkedAt"`
	LatestTag   string    `json:"latestTag"`
	DownloadURL string    `json:"downloadURL"`
	Body        string    `json:"body"`
}

type ghRelease struct {
	TagName string `json:"tag_name"`
	Body    string `json:"body"`
	Assets  []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
	} `json:"assets"`
}

// CheckForUpdate returns a non-nil UpdateInfo when the GitHub Releases
// API (or a fresh-enough cache) advertises a tag newer than current.
// Errors are returned for callers that care, but the TUI treats any
// failure as "no banner" — an offline laptop must not nag.
func CheckForUpdate(ctx context.Context, currentVersion string) (*UpdateInfo, error) {
	if cached, ok := readCachedUpdate(); ok {
		if isNewerVersion(cached.LatestTag, currentVersion) {
			return &UpdateInfo{
				LatestTag:   cached.LatestTag,
				DownloadURL: cached.DownloadURL,
				Body:        cached.Body,
			}, nil
		}
		return nil, nil
	}
	info, err := fetchLatestRelease(ctx)
	if err != nil {
		return nil, err
	}
	writeCachedUpdate(info)
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

func updateCachePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude-monitor", "update-check.json"), nil
}

func readCachedUpdate() (*updateCache, bool) {
	p, err := updateCachePath()
	if err != nil {
		return nil, false
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, false
	}
	var c updateCache
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, false
	}
	if time.Since(c.CheckedAt) > updateCacheTTL {
		return nil, false
	}
	return &c, true
}

func writeCachedUpdate(info *UpdateInfo) {
	p, err := updateCachePath()
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	b, err := json.MarshalIndent(updateCache{
		CheckedAt:   time.Now(),
		LatestTag:   info.LatestTag,
		DownloadURL: info.DownloadURL,
		Body:        info.Body,
	}, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(p, b, 0o644)
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

	// Drop the cache so the just-installed version isn't immediately
	// re-flagged on the next launch.
	if p, err := updateCachePath(); err == nil {
		_ = os.Remove(p)
	}
	return nil
}

// cleanupStaleUpgradeArtifacts removes leftover <exe>.old / <exe>.new
// files from prior upgrades. Called once at startup. Best-effort: any
// permission error is swallowed because it's non-essential.
func cleanupStaleUpgradeArtifacts() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	_ = os.Remove(exe + ".old")
	_ = os.Remove(exe + ".new")
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
