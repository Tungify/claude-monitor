package keychain

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestLockOAuthRefreshBasic pins the happy path: an uncontended caller
// gets the lock, the lockdir exists on disk, and Release removes it.
func TestLockOAuthRefreshBasic(t *testing.T) {
	tmp := t.TempDir()
	release, err := LockOAuthRefresh(context.Background(), tmp)
	if err != nil {
		t.Fatalf("LockOAuthRefresh: %v", err)
	}
	if _, err := os.Stat(filepath.Join(tmp, ".oauth_refresh.lock")); err != nil {
		t.Errorf("lockdir not created: %v", err)
	}
	release()
	if _, err := os.Stat(filepath.Join(tmp, ".oauth_refresh.lock")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("lockdir still present after release: %v", err)
	}
}

// TestLockOAuthRefreshSerializes proves that two contending callers
// never hold the lock concurrently. With the polling step at 100ms
// and a deliberately-slow holder (200ms), the second caller is forced
// to wait through at least one poll cycle before acquiring.
func TestLockOAuthRefreshSerializes(t *testing.T) {
	tmp := t.TempDir()
	var inFlight, peak int32
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			release, err := LockOAuthRefresh(context.Background(), tmp)
			if err != nil {
				t.Errorf("LockOAuthRefresh: %v", err)
				return
			}
			cur := atomic.AddInt32(&inFlight, 1)
			for {
				old := atomic.LoadInt32(&peak)
				if cur <= old || atomic.CompareAndSwapInt32(&peak, old, cur) {
					break
				}
			}
			time.Sleep(50 * time.Millisecond)
			atomic.AddInt32(&inFlight, -1)
			release()
		}()
	}
	wg.Wait()
	if got := atomic.LoadInt32(&peak); got != 1 {
		t.Errorf("peak in-flight = %d, want 1 (lock should serialize)", got)
	}
}

// TestLockOAuthRefreshStaleTakeover simulates a crashed holder: a
// pre-existing lockdir whose mtime is older than oauthLockStale. The
// next caller must steal it within one poll cycle rather than blocking
// to the full timeout.
func TestLockOAuthRefreshStaleTakeover(t *testing.T) {
	tmp := t.TempDir()
	lock := filepath.Join(tmp, ".oauth_refresh.lock")
	if err := os.Mkdir(lock, 0o700); err != nil {
		t.Fatalf("seed lockdir: %v", err)
	}
	// Backdate well past the stale threshold.
	old := time.Now().Add(-oauthLockStale - time.Second)
	if err := os.Chtimes(lock, old, old); err != nil {
		t.Fatalf("backdate lockdir: %v", err)
	}

	start := time.Now()
	release, err := LockOAuthRefresh(context.Background(), tmp)
	if err != nil {
		t.Fatalf("LockOAuthRefresh: %v", err)
	}
	elapsed := time.Since(start)
	t.Cleanup(release)

	if elapsed > 500*time.Millisecond {
		t.Errorf("stale takeover took %s, expected near-immediate", elapsed)
	}
}

// TestLockOAuthRefreshRespectsContext: a contender canceled mid-wait
// must return promptly with ctx.Err(), not block out the whole 15s
// timeout — otherwise a TUI Quit during the morning rush strands
// every pending fetchOne goroutine.
func TestLockOAuthRefreshRespectsContext(t *testing.T) {
	tmp := t.TempDir()
	holder, err := LockOAuthRefresh(context.Background(), tmp)
	if err != nil {
		t.Fatalf("seed holder: %v", err)
	}
	t.Cleanup(holder)

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(150 * time.Millisecond)
		cancel()
	}()

	start := time.Now()
	_, err = LockOAuthRefresh(ctx, tmp)
	elapsed := time.Since(start)
	if !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v, want context.Canceled", err)
	}
	if elapsed > time.Second {
		t.Errorf("wait elapsed %s, expected near 150ms (ctx cancel)", elapsed)
	}
}
