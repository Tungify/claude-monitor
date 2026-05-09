// Package tunnel manages an external `cloudflared` subprocess that
// publishes the loopback Next.js orchestrator at a public HTTPS URL.
//
// We use cloudflared's "quick tunnel" mode (`cloudflared tunnel --url
// http://127.0.0.1:<port>`), which:
//   - Requires no Cloudflare account / DNS setup.
//   - Picks a random `*.trycloudflare.com` URL each launch.
//   - Has built-in TLS, DDoS shielding, and HTTP/3.
//
// The Go side never sees the public traffic directly — cloudflared
// terminates TLS and forwards plain HTTP to 127.0.0.1. So all auth /
// IP-allowlist enforcement still lives in web/proxy.ts; this package
// only worries about the subprocess lifecycle and capturing the URL.
//
// Cloudflared adds a `CF-Connecting-IP` header before forwarding, which
// proxy.ts uses for IP-allowlist checks (see web/proxy.ts).
package tunnel

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// ErrNotInstalled is returned by Start when no cloudflared binary can
// be located on PATH (or at the explicit path passed in). The caller
// should surface a friendly install hint to the user.
var ErrNotInstalled = errors.New("cloudflared binary not found on PATH; install from https://developers.cloudflare.com/cloudflared/")

// urlRe matches the public URL cloudflared prints once the tunnel is
// up. Its log format has churned over the years; the trycloudflare.com
// domain has stayed consistent so we anchor on that.
//
// Sample stdout fragment we're matching against:
//
//	2024-01-01T12:00:00Z INF |  Your quick Tunnel has been created! Visit it at:
//	2024-01-01T12:00:00Z INF |  https://thirsty-window-0123.trycloudflare.com
var urlRe = regexp.MustCompile(`https://[a-z0-9-]+\.trycloudflare\.com`)

// known cloudflared error patterns we want to lift into Status.Err so
// the UI can show something more useful than "exit status 1". The
// regex on the right of each entry matches a fragment of cloudflared's
// stderr; the message on the left is what we surface. Order matters
// (first match wins) — keep the more specific patterns first.
var knownErrors = []struct {
	pat     *regexp.Regexp
	message string
}{
	{regexp.MustCompile(`neither the ID nor the name of any of your tunnels`),
		"named tunnel not found — run `cloudflared tunnel login`, then `cloudflared tunnel create <name>` and `cloudflared tunnel route dns <name> <hostname>` first"},
	{regexp.MustCompile(`(?i)cert\.pem.*(no such file|not found)`),
		"cloudflared credentials missing — run `cloudflared tunnel login` first"},
	{regexp.MustCompile(`(?i)Cannot determine default origin certificate`),
		"cloudflared not logged in — run `cloudflared tunnel login` first"},
	{regexp.MustCompile(`(?i)credentials file.*not found`),
		"tunnel credentials file missing — run `cloudflared tunnel create <name>` first"},
	{regexp.MustCompile(`(?i)error parsing tunnel ID`),
		"tunnel name not recognized — verify with `cloudflared tunnel list`"},
}

// registeredRe matches cloudflared's confirmation that a tunnel
// connector has been accepted by the edge. Without this signal we'd
// flip Status.Pending to false the moment the URL is known, which
// for named tunnels happens immediately on Start (the hostname comes
// from config, not log scraping) — long before cold-start DNS work
// finishes and traffic actually flows. The result was a UI showing
// "ready" while the public URL still served Error 1033. Sample line:
//
//	INF Registered tunnel connection connIndex=0 connection=… protocol=http2
var registeredRe = regexp.MustCompile(`Registered tunnel connection`)

// Tunnel owns a single `cloudflared tunnel --url ...` subprocess.
//
// Concurrency: Status() is RLock-cheap. Start/Stop serialize via mu.
// The URL field flips from "" to the captured value once cloudflared
// prints it — typically within 2-5s of Start, but can stretch to ~15s
// on cold starts when CF picks an edge for the first time.
//
// Lifetime: the subprocess is bound to an internal context created on
// Start and cancelled on Stop, NOT to the ctx passed into Start. That
// distinction matters because Start is typically called from an HTTP
// handler whose request ctx ends as soon as the response is flushed —
// using exec.CommandContext(ctxFromRequest, …) would kill cloudflared
// the moment the user's "enable" click resolved.
type Tunnel struct {
	binPath string

	mu        sync.RWMutex
	cmd       *exec.Cmd
	cancelCmd context.CancelFunc // cancels the subprocess's lifetime ctx
	url       string
	running   bool
	// registered flips true the first time cloudflared logs
	// "Registered tunnel connection" — that's the earliest moment the
	// edge will route traffic to us. Resets on every Start() so a
	// recycle goes back to pending. Reading Pending = Running &&
	// !registered (instead of `URL == ""`) gives the right answer
	// for named tunnels too, where URL is filled in at Start time.
	registered bool
	err        error // last lifecycle error, surfaced via Status

	// Named tunnel mode. Both empty = quick tunnel (default).
	tunnelName string
	hostname   string

	// done fires once cmd.Wait returns. Used by Stop() to enforce a
	// timeout escalation (SIGTERM → SIGKILL) without leaking the
	// goroutine on the happy path.
	done chan struct{}
}

// Status is the public-shaped view returned to UI callers. URL is
// empty until cloudflared has printed it; Running is true once Start
// has succeeded (even if URL hasn't been parsed yet).
type Status struct {
	Running    bool   `json:"running"`
	Registered bool   `json:"registered,omitempty"`
	URL        string `json:"url,omitempty"`
	Err        string `json:"error,omitempty"`
}

// New constructs a Tunnel. Pass an empty binPath to use whatever's on
// PATH; pass an absolute path to pin a specific binary (useful when
// the user has cloudflared in a non-standard location).
func New(binPath string) *Tunnel {
	if binPath == "" {
		binPath = "cloudflared"
	}
	return &Tunnel{binPath: binPath}
}

// Named configures the tunnel to use a pre-created cloudflared named
// tunnel instead of a quick tunnel. Quick tunnels deliberately buffer
// SSE GET responses (Cloudflare guardrail — see cloudflared#1449), so
// real-time streaming requires a named tunnel. The caller must have
// already run `cloudflared tunnel create <name>` and routed DNS via
// `cloudflared tunnel route dns <name> <hostname>`.
//
// Empty name clears named-tunnel mode and falls back to quick tunnel.
func (t *Tunnel) Named(name, hostname string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.tunnelName = name
	t.hostname = hostname
}

// Status returns a snapshot. Cheap to call repeatedly; safe under
// concurrent Start/Stop.
func (t *Tunnel) Status() Status {
	t.mu.RLock()
	defer t.mu.RUnlock()
	s := Status{Running: t.running, Registered: t.registered, URL: t.url}
	if t.err != nil {
		s.Err = t.err.Error()
	}
	return s
}

// Start launches cloudflared pointing at localURL (typically
// http://127.0.0.1:<webPort>) and returns once cmd.Start succeeds.
// Poll Status() (or AwaitURL) to learn the public URL.
//
// Idempotent: calling Start while already running is a no-op.
//
// The ctx parameter is used ONLY to abort the bin-lookup / cmd.Start
// portion if the caller's request times out. The cloudflared
// subprocess itself is bound to an internal long-lived context so it
// survives the HTTP handler that triggered it. Use Stop() (or process
// shutdown) for teardown.
func (t *Tunnel) Start(ctx context.Context, localURL string) error {
	t.mu.Lock()
	if t.running {
		t.mu.Unlock()
		return nil
	}

	// Resolve binary up-front so we can return a typed error before
	// allocating the subprocess. exec.LookPath also handles the case
	// where the user passed an absolute path that doesn't exist.
	if _, err := exec.LookPath(t.binPath); err != nil {
		t.mu.Unlock()
		return ErrNotInstalled
	}

	// Independent lifetime ctx — see struct comment for why we don't
	// inherit the caller's. Cancelled by Stop() to terminate the
	// subprocess gracefully (with SIGINT first via cmd.Process.Signal,
	// then context-driven kill if it ignores).
	cmdCtx, cancel := context.WithCancel(context.Background())
	args := []string{
		"tunnel",
		// `--no-autoupdate` keeps cloudflared from doing a self-update
		// dance during our subprocess lifetime — we'd rather have
		// stable behaviour than the latest patch.
		"--no-autoupdate",
		"--url", localURL,
	}
	if t.tunnelName != "" {
		// Named tunnel: append `run <name>`. cloudflared uses the
		// credentials from ~/.cloudflared/<UUID>.json (created by
		// `cloudflared tunnel create`) and routes traffic to localURL.
		args = append(args, "run", t.tunnelName)
	}
	cmd := exec.CommandContext(cmdCtx, t.binPath, args...)
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		t.mu.Unlock()
		return fmt.Errorf("pipe stderr: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		t.mu.Unlock()
		return fmt.Errorf("pipe stdout: %w", err)
	}

	if err := cmd.Start(); err != nil {
		cancel()
		t.mu.Unlock()
		return fmt.Errorf("start cloudflared: %w", err)
	}
	// Log the exact invocation so debugging "why is the URL wrong?"
	// doesn't require a second ssh into the machine. Goes to stderr
	// alongside the [cloudflared] prefixed output.
	fmt.Fprintf(os.Stderr, "[cloudflared] launching: %s %s\n", t.binPath, strings.Join(args, " "))

	t.cmd = cmd
	t.cancelCmd = cancel
	t.running = true
	t.registered = false
	t.err = nil
	// Named tunnel: hostname is fixed by user-side `tunnel route dns`,
	// so we set the URL up-front instead of scraping cloudflared logs
	// (which only print the trycloudflare.com URL for quick tunnels).
	if t.tunnelName != "" && t.hostname != "" {
		t.url = "https://" + t.hostname
	} else {
		t.url = ""
	}
	t.done = make(chan struct{})
	doneCh := t.done
	t.mu.Unlock()
	// Best-effort: if the caller's ctx is already cancelled by the
	// time we got here (e.g. the user clicked twice fast and the
	// second click's context fired), that's fine — the subprocess is
	// already attached to its own ctx and will keep running until
	// Stop. We just use ctx for the bind-time short-circuit above.
	_ = ctx

	// Two scanners (stdout + stderr) racing to find the URL.
	// cloudflared has historically printed it on stderr but the format
	// drifts; tee-ing both to os.Stderr also keeps the user-visible
	// log experience similar to running cloudflared directly.
	go t.scan(stdout, os.Stderr)
	go t.scan(stderr, os.Stderr)

	// Reaper: marks the tunnel as not-running once cloudflared exits
	// (clean stop or crash). Also clears URL/registered so a follow-up
	// Status() — or a subsequent Start with a different tunnel mode —
	// doesn't leak the previous run's identity into the UI (e.g. user
	// disables a quick tunnel, configures a named tunnel, re-enables;
	// without this clear the bridge's first Status() return after
	// Start would race against the new t.url assignment and could
	// stamp the response with the stale trycloudflare URL).
	go func() {
		err := cmd.Wait()
		t.mu.Lock()
		t.running = false
		t.url = ""
		t.registered = false
		// Only stamp the cmd.Wait error if scan() hasn't already lifted
		// a friendlier message (e.g. "named tunnel not found"). The raw
		// exit error reads as "exit status 1" which is useless to a
		// user trying to figure out what went wrong.
		if err != nil && !errors.Is(err, context.Canceled) && t.err == nil {
			t.err = err
		}
		t.mu.Unlock()
		close(doneCh)
	}()

	return nil
}

// scan reads lines from r, mirrors them to mirror, and watches for the
// trycloudflare.com URL. First match wins; subsequent matches are
// ignored so a log line that quotes the same URL doesn't reset state.
//
// Side-effect: known error fragments (see knownErrors) are lifted into
// t.err so the UI can show something more useful than "exit status 1"
// — the most common cause of named-tunnel failure is the user skipping
// the one-time `cloudflared tunnel login/create/route dns` setup, and
// that error lands on stderr a beat before cloudflared exits.
func (t *Tunnel) scan(r io.Reader, mirror io.Writer) {
	sc := bufio.NewScanner(r)
	// Cloudflared can dump JSON-formatted logs that exceed 64KB
	// occasionally; bump the buffer so we don't drop lines.
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if mirror != nil {
			_, _ = mirror.Write(append([]byte("[cloudflared] "), append(line, '\n')...))
		}
		t.mu.RLock()
		captured := t.url != ""
		registered := t.registered
		hadErr := t.err != nil
		t.mu.RUnlock()
		if !captured {
			// Named tunnels never want a trycloudflare match — the URL
			// comes from the user's hostname, not a quick-tunnel hostname
			// that cloudflared might emit in passing log output. The
			// `captured` guard above already skips the regex when t.url
			// is non-empty (which it is for named tunnels, set in Start),
			// but we double-check tunnelName here so a future refactor
			// that briefly nils t.url can't regress the named-tunnel UI.
			t.mu.RLock()
			named := t.tunnelName != ""
			t.mu.RUnlock()
			if !named {
				if m := urlRe.Find(line); m != nil {
					t.mu.Lock()
					if t.url == "" {
						t.url = string(m)
					}
					t.mu.Unlock()
				}
			}
		}
		if !registered && registeredRe.Match(line) {
			t.mu.Lock()
			t.registered = true
			t.mu.Unlock()
		}
		// Lift known error patterns into t.err so UI can show something
		// useful. We only set the FIRST one we see — once t.err is
		// populated, later cascading errors (e.g. "connection failed"
		// after "credentials missing") would just obscure the root.
		if !hadErr {
			for _, ke := range knownErrors {
				if ke.pat.Match(line) {
					t.mu.Lock()
					if t.err == nil {
						t.err = errors.New(ke.message)
					}
					t.mu.Unlock()
					break
				}
			}
		}
	}
}

// AwaitURL blocks until either the URL is captured, the tunnel exits,
// or ctx is cancelled. Returns the URL on success, or an error
// describing what went wrong (e.g. cloudflared crashed before
// publishing). A 30s timeout in the caller is recommended — quick
// tunnels typically print the URL within 2-5s of bind.
func (t *Tunnel) AwaitURL(ctx context.Context) (string, error) {
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		s := t.Status()
		if s.URL != "" {
			return s.URL, nil
		}
		if !s.Running {
			if s.Err != "" {
				return "", errors.New(s.Err)
			}
			return "", errors.New("cloudflared exited before publishing a URL")
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-tick.C:
		}
	}
}

// Stop sends SIGTERM and waits up to timeout, then escalates to Kill
// (via the internal lifetime ctx). Idempotent — safe to call when not
// running.
func (t *Tunnel) Stop(timeout time.Duration) {
	t.mu.Lock()
	cmd := t.cmd
	doneCh := t.done
	cancel := t.cancelCmd
	running := t.running
	t.mu.Unlock()
	if !running || cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Signal(os.Interrupt)
	if doneCh == nil {
		return
	}
	select {
	case <-doneCh:
	case <-time.After(timeout):
		// Cancel the lifetime ctx — exec.CommandContext will SIGKILL
		// the process. cmd.Process.Kill would also work but the ctx
		// path is cleaner and matches the lifecycle invariant.
		if cancel != nil {
			cancel()
		}
		<-doneCh
	}
}
