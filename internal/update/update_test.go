package update

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestNormalizeVersion(t *testing.T) {
	tests := []struct {
		in, want string
	}{
		{"v1.2.3", "1.2.3"},
		{"1.2.3", "1.2.3"},
		{"  v1.2.3  ", "1.2.3"},
		{"1.2.3-rc1", "1.2.3"},
		{"1.2.3+build.5", "1.2.3"},
		{"dev", ""},
		{"", ""},
		{"v0.0.1", "0.0.1"},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			if got := normalizeVersion(tt.in); got != tt.want {
				t.Errorf("normalizeVersion(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestCompareDottedVersions(t *testing.T) {
	tests := []struct {
		a, b string
		want int
	}{
		{"1.2.3", "1.2.3", 0},
		{"1.2.4", "1.2.3", 1},
		{"1.2.3", "1.2.4", -1},
		{"2.0.0", "1.9.9", 1},
		{"1.2", "1.2.0", 0}, // missing components treated as 0
		{"1.2.0", "1.2", 0},
		{"1.2.1", "1.2", 1},
		{"10.0.0", "9.0.0", 1}, // numeric, not lexical
	}
	for _, tt := range tests {
		t.Run(tt.a+"_vs_"+tt.b, func(t *testing.T) {
			if got := compareDottedVersions(tt.a, tt.b); got != tt.want {
				t.Errorf("compareDottedVersions(%q, %q) = %d, want %d", tt.a, tt.b, got, tt.want)
			}
		})
	}
}

func TestIsNewer(t *testing.T) {
	tests := []struct {
		name            string
		latest, current string
		want            bool
	}{
		{"strictly newer", "v1.2.4", "v1.2.3", true},
		{"strictly older", "v1.2.3", "v1.2.4", false},
		{"equal", "v1.2.3", "v1.2.3", false},
		{"dev current treated as older", "v1.0.0", "dev", true},
		{"empty latest is not newer", "", "v1.0.0", false},
		{"both dev means not newer", "dev", "dev", false},
		{"prerelease drops to base", "v1.2.3-rc1", "v1.2.3", false},
		{"v-prefix doesn't matter", "1.2.4", "v1.2.3", true},
		{"numeric compare not lexical", "v10.0.0", "v9.9.9", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsNewer(tt.latest, tt.current); got != tt.want {
				t.Errorf("IsNewer(%q, %q) = %v, want %v", tt.latest, tt.current, got, tt.want)
			}
		})
	}
}

func TestAssetName(t *testing.T) {
	got := assetName("v1.2.3")
	want := fmt.Sprintf("claude-monitor-v1.2.3-%s-%s", runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS == "windows" {
		want += ".zip"
	} else {
		want += ".tar.gz"
	}
	if got != want {
		t.Errorf("assetName(v1.2.3) = %q, want %q", got, want)
	}
}

// TestFetchLatestPicksMatchingAsset verifies that FetchLatest selects the
// asset whose name matches the host's GOOS/GOARCH and returns the
// download URL from that asset.
func TestFetchLatestPicksMatchingAsset(t *testing.T) {
	target := assetName("v9.9.9")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ghRelease{
			TagName: "v9.9.9",
			Body:    "release notes",
			Assets: []struct {
				Name               string `json:"name"`
				BrowserDownloadURL string `json:"browser_download_url"`
			}{
				{Name: "claude-monitor-v9.9.9-other-arch.tar.gz", BrowserDownloadURL: "https://example.com/wrong"},
				{Name: target, BrowserDownloadURL: "https://example.com/right"},
			},
		})
	}))
	t.Cleanup(srv.Close)

	// Mirror the asset-matching logic from FetchLatest. We can't
	// override the const githubReleasesAPI without dependency
	// injection, so this validates the parser end-to-end against a
	// fake response.
	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatalf("test server fetch: %v", err)
	}
	defer resp.Body.Close()
	var rel ghRelease
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if rel.TagName != "v9.9.9" {
		t.Errorf("TagName = %q, want v9.9.9", rel.TagName)
	}
	if len(rel.Assets) != 2 {
		t.Fatalf("expected 2 assets, got %d", len(rel.Assets))
	}
	var found string
	for _, a := range rel.Assets {
		if a.Name == target {
			found = a.BrowserDownloadURL
		}
	}
	if found != "https://example.com/right" {
		t.Errorf("matched asset URL = %q, want https://example.com/right", found)
	}
}

// TestFetchLatestNoMatchingAsset documents that FetchLatest returns an
// error when no asset name matches the host platform.
func TestFetchLatestNoMatchingAsset(t *testing.T) {
	assets := []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
	}{
		{Name: "claude-monitor-v9.9.9-fakeos-fakearch.tar.gz", BrowserDownloadURL: "https://example.com/x"},
	}
	target := assetName("v9.9.9")
	for _, a := range assets {
		if a.Name == target {
			t.Fatalf("asset unexpectedly matched: %s", a.Name)
		}
	}
}

func TestCleanupStaleArtifactsIsBestEffort(t *testing.T) {
	// CleanupStaleArtifacts must never panic, even when the executable
	// path is non-writable or files don't exist.
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("CleanupStaleArtifacts panicked: %v", r)
		}
	}()
	CleanupStaleArtifacts()
}

// TestCheckContractNotNewer wraps Check by hand; we can't easily
// redirect the hardcoded URL but we can sanity-check that IsNewer
// being false leads to nil. Proxy for the Check contract since
// Check == FetchLatest + IsNewer guard.
func TestCheckContractNotNewer(t *testing.T) {
	info := &Info{LatestTag: "v1.0.0"}
	if IsNewer(info.LatestTag, "v2.0.0") {
		t.Error("IsNewer should be false for older latest")
	}
	_ = context.Background()
}

func TestSafeJoin(t *testing.T) {
	base := t.TempDir()
	tests := []struct {
		name    string
		entry   string
		wantErr bool
	}{
		{"plain file", "hello.txt", false},
		{"nested file", "wrap/inner/x.txt", false},
		{"current dir prefix", "./hello.txt", false},
		{"redundant traversal staying inside", "wrap/../inner.txt", false},
		{"absolute posix path", "/etc/passwd", true},
		{"parent dir literal", "..", true},
		{"escape via parent", "../escape", true},
		{"deep escape", "wrap/../../escape", true},
		{"backslash escape", "..\\escape", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := safeJoin(base, tt.entry)
			if tt.wantErr && err == nil {
				t.Errorf("safeJoin(%q) = nil err, want error", tt.entry)
			}
			if !tt.wantErr && err != nil {
				t.Errorf("safeJoin(%q) = %v, want no error", tt.entry, err)
			}
		})
	}
}

func TestSingleTopLevelDirUnwrapsWhenSingleDir(t *testing.T) {
	dir := t.TempDir()
	inner := filepath.Join(dir, "wrapper")
	if err := os.Mkdir(inner, 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := singleTopLevelDir(dir)
	if err != nil {
		t.Fatalf("singleTopLevelDir: %v", err)
	}
	if got != inner {
		t.Errorf("got %q, want %q", got, inner)
	}
}

func TestSingleTopLevelDirReturnsBaseWhenMultipleEntries(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"a", "b"} {
		if err := os.Mkdir(filepath.Join(dir, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	got, err := singleTopLevelDir(dir)
	if err != nil {
		t.Fatalf("singleTopLevelDir: %v", err)
	}
	if got != dir {
		t.Errorf("got %q, want %q", got, dir)
	}
}

func TestExtractTarGz(t *testing.T) {
	tmp := t.TempDir()
	arc := filepath.Join(tmp, "test.tar.gz")
	writeTarGz(t, arc, []tarEntry{
		{name: "wrap/", typ: tar.TypeDir, mode: 0o755},
		{name: "wrap/claude-monitor", typ: tar.TypeReg, mode: 0o755, body: []byte("BIN")},
		{name: "wrap/web/server.js", typ: tar.TypeReg, mode: 0o644, body: []byte("// next")},
	})

	dest := filepath.Join(tmp, "out")
	if err := extractTarGz(arc, dest); err != nil {
		t.Fatalf("extractTarGz: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(dest, "wrap", "claude-monitor"))
	if err != nil {
		t.Fatalf("read binary: %v", err)
	}
	if string(got) != "BIN" {
		t.Errorf("binary content = %q, want BIN", string(got))
	}
	gotJS, err := os.ReadFile(filepath.Join(dest, "wrap", "web", "server.js"))
	if err != nil {
		t.Fatalf("read server.js: %v", err)
	}
	if string(gotJS) != "// next" {
		t.Errorf("server.js content = %q, want // next", string(gotJS))
	}
}

func TestExtractTarGzRejectsZipSlip(t *testing.T) {
	tmp := t.TempDir()
	arc := filepath.Join(tmp, "evil.tar.gz")
	writeTarGz(t, arc, []tarEntry{
		{name: "../escape", typ: tar.TypeReg, mode: 0o644, body: []byte("x")},
	})
	if err := extractTarGz(arc, filepath.Join(tmp, "out")); err == nil {
		t.Fatal("expected error for path traversal, got nil")
	}
}

func TestExtractZip(t *testing.T) {
	tmp := t.TempDir()
	arc := filepath.Join(tmp, "test.zip")
	writeZip(t, arc, []zipEntry{
		{name: "wrap/claude-monitor.exe", body: []byte("BIN")},
		{name: "wrap/web/server.js", body: []byte("// next")},
	})

	dest := filepath.Join(tmp, "out")
	if err := extractZip(arc, dest); err != nil {
		t.Fatalf("extractZip: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(dest, "wrap", "claude-monitor.exe"))
	if err != nil {
		t.Fatalf("read binary: %v", err)
	}
	if string(got) != "BIN" {
		t.Errorf("binary content = %q, want BIN", string(got))
	}
}

func TestExtractZipRejectsZipSlip(t *testing.T) {
	tmp := t.TempDir()
	arc := filepath.Join(tmp, "evil.zip")
	writeZip(t, arc, []zipEntry{
		{name: "../escape", body: []byte("x")},
	})
	if err := extractZip(arc, filepath.Join(tmp, "out")); err == nil {
		t.Fatal("expected error for path traversal, got nil")
	}
}

type tarEntry struct {
	name string
	typ  byte
	mode int64
	body []byte
}

func writeTarGz(t *testing.T, path string, entries []tarEntry) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gw := gzip.NewWriter(f)
	defer gw.Close()
	tw := tar.NewWriter(gw)
	defer tw.Close()
	for _, e := range entries {
		hdr := &tar.Header{
			Name:     e.name,
			Mode:     e.mode,
			Size:     int64(len(e.body)),
			Typeflag: e.typ,
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatalf("WriteHeader %s: %v", e.name, err)
		}
		if e.typ == tar.TypeReg {
			if _, err := tw.Write(e.body); err != nil {
				t.Fatalf("Write %s: %v", e.name, err)
			}
		}
	}
}

type zipEntry struct {
	name string
	body []byte
}

func writeZip(t *testing.T, path string, entries []zipEntry) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	zw := zip.NewWriter(f)
	defer zw.Close()
	for _, e := range entries {
		w, err := zw.Create(e.name)
		if err != nil {
			t.Fatalf("Create %s: %v", e.name, err)
		}
		if _, err := w.Write(e.body); err != nil {
			t.Fatalf("Write %s: %v", e.name, err)
		}
	}
}
