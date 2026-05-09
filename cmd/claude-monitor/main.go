package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"claude-monitor/internal/account"
	"claude-monitor/internal/config"
	"claude-monitor/internal/keychain"
	"claude-monitor/internal/server"
	"claude-monitor/internal/swap"
	"claude-monitor/internal/tui"
	"claude-monitor/internal/tunnel"
	"claude-monitor/internal/update"
	webx "claude-monitor/internal/web"
)

var (
	flagRoot = flag.String("root", "",
		"Account search path. Empty = auto-discover ~/.claude* in $HOME. "+
			"Otherwise a comma-separated list of paths; each path can be a single "+
			"Claude config dir or a parent directory containing several.")
	flagVersion = flag.Bool("version", false, "Print version and exit")
	flagUpgrade = flag.Bool("upgrade", false, "Download and install the latest release, then exit")
	flagSwapTo  = flag.String("swap-to", "",
		"Rewrite the default keychain slot to the given account (by name, email, or config dir) and exit. "+
			"Lets a `/switch-account` slash command flip the running `claude` tab to a different account.")
	flagListAccounts = flag.Bool("list-accounts", false,
		"Print discovered accounts (name, email, 5h utilization, active marker) and exit.")
	flagKeychainSetup = flag.Bool("keychain-setup", false,
		"Re-register claude-monitor with the macOS keychain so account swaps don't prompt for "+
			"a password every time. Asks for your macOS user password once (not stored). "+
			"No-op on Linux/Windows.")
	flagServe = flag.String("serve", "",
		"Daemon-only mode: bind an HTTP+SSE API at the given address (e.g. 127.0.0.1:8788) "+
			"for an external UI to consume, no web subprocess, no TUI.")
	flagTui = flag.Bool("tui", false,
		"Run the legacy terminal dashboard instead of the web orchestrator.")
	flagDaemonAddr = flag.String("daemon-addr", "127.0.0.1:8788",
		"Bind address for the daemon HTTP+SSE API used by the web orchestrator.")
	flagWebPort = flag.Int("web-port", 3737,
		"Port the spawned Next.js web orchestrator binds to.")
	flagWebHost = flag.String("web-host", "127.0.0.1",
		"Bind hostname for the Next.js web orchestrator. Use 0.0.0.0 to expose "+
			"on the LAN (a phone on the same Wi-Fi can then reach it). When non-loopback, "+
			"a bearer token is auto-generated unless --auth-token is set.")
	flagWebDir = flag.String("web-dir", "",
		"Path to the web/ directory. Empty = auto-discover relative to the binary.")
	flagNoOpen = flag.Bool("no-open", false,
		"Don't open the web orchestrator URL in the default browser on startup.")
	flagNoWeb = flag.Bool("no-web", false,
		"Run only the daemon (skip spawning the Next.js web orchestrator). "+
			"Equivalent to --serve $daemon-addr but keeps the convenient defaults.")
	flagLAN = flag.Bool("lan", false,
		"LAN convenience: bind --web-host=0.0.0.0, generate an auth token, "+
			"print the LAN URL + QR code so a phone on the same Wi-Fi can scan in.")
	flagAuthToken = flag.String("auth-token", "",
		"Shared bearer token enforced by the Next.js proxy when the web bind is "+
			"non-loopback. Empty = auto-generate per launch (printed at startup). "+
			"Set explicitly if you want a stable token across restarts.")
	flagLANIP = flag.String("lan-ip", "",
		"Override the LAN IP printed alongside the QR code. Empty = auto-discover "+
			"the first non-loopback IPv4. Useful on multi-homed hosts where the "+
			"auto-pick lands on the wrong interface.")
	flagLANOff = flag.Bool("lan-off", false,
		"Emergency kill-switch: disable LAN exposure on the running daemon "+
			"(or clear ~/.claude-monitor/config.json if no daemon is running). "+
			"Use when you've lost the QR/token URL and the auth gate has locked you out.")
	flagPublic = flag.Bool("public", false,
		"Public exposure via Cloudflare Tunnel: spawn `cloudflared tunnel --url ...` "+
			"and print the public HTTPS URL + QR. Implies --lan (sets the token gate). "+
			"Requires `cloudflared` on PATH — install from https://developers.cloudflare.com/cloudflared/")
	flagAllowIP = flag.String("allow-ip", "",
		"Comma-separated IPs / CIDR ranges allowed past the auth gate (in addition to "+
			"the bearer token). Empty = token-only. Recommended for --public so a leaked "+
			"token alone isn't sufficient. Example: --allow-ip \"203.0.113.7,2001:db8::/32\"")
	flagCloudflared = flag.String("cloudflared", "cloudflared",
		"Path to the cloudflared binary. Empty / unset = look up on PATH.")
	flagCfTunnel = flag.String("cf-tunnel", "",
		"Cloudflare named tunnel to use instead of a quick tunnel. "+
			"Quick tunnels deliberately buffer SSE GET responses (Cloudflare "+
			"guardrail), which breaks our /api/events stream — the web UI "+
			"shows an empty accounts list. Named tunnels stream cleanly. "+
			"Prereq: `cloudflared tunnel login` + `cloudflared tunnel create <name>` + "+
			"`cloudflared tunnel route dns <name> <hostname>`. Pair with --cf-hostname.")
	flagCfHostname = flag.String("cf-hostname", "",
		"Public hostname routed to the --cf-tunnel (e.g. monitor.example.com). "+
			"Used as the printed public URL — cloudflared doesn't echo it back, "+
			"so we take it from the flag.")
)

// version is wired by ldflags via the Makefile.
var version = "dev"

func main() {
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr,
			"claude-monitor — orchestrate multiple Claude Code OAuth accounts.\n\n"+
				"Default mode boots an in-process daemon (--daemon-addr) and spawns the\n"+
				"Next.js web orchestrator (--web-port), then opens it in your browser.\n"+
				"Pass --tui for the legacy terminal dashboard, --serve for daemon-only,\n"+
				"or --lan to expose the web UI to your phone on the same Wi-Fi (the\n"+
				"daemon stays on loopback; a token-gated proxy fronts every endpoint).\n\n"+
				"Usage:\n  %s [flags]\n\nFlags:\n", os.Args[0])
		flag.PrintDefaults()
	}
	flag.Parse()

	if *flagVersion {
		fmt.Println(version)
		return
	}

	if *flagUpgrade {
		if err := runUpgrade(); err != nil {
			die("upgrade failed: %v", err)
		}
		return
	}

	if *flagListAccounts {
		if err := swap.ListAccounts(*flagRoot); err != nil {
			die("%v", err)
		}
		return
	}

	if *flagSwapTo != "" {
		if err := swap.To(*flagRoot, *flagSwapTo); err != nil {
			die("%v", err)
		}
		return
	}

	if *flagLANOff {
		if err := runLANOff(*flagDaemonAddr); err != nil {
			die("lan-off: %v", err)
		}
		return
	}

	cfg, _ := config.Load() // missing/corrupt → defaults; not fatal

	if *flagServe != "" {
		if err := runServe(*flagServe, *flagRoot, cfg); err != nil {
			die("daemon: %v", err)
		}
		return
	}

	if *flagKeychainSetup {
		if err := keychain.RunSetup(discoverConfigDirs(*flagRoot)); err != nil {
			die("%v", err)
		}
		cfg.KeychainSetupDone = true
		_ = config.Save(cfg)
		return
	}

	// Clean up <exe>.old / <exe>.new from prior upgrades — Windows
	// can't remove them while the running process holds them.
	update.CleanupStaleArtifacts()

	// One-shot keychain registration on the first launch so future
	// swaps don't pop a password prompt every time. RunSetup is a
	// no-op on Linux/Windows (no partition list to update) and
	// short-circuits on darwin if stdin isn't a TTY or there are no
	// accounts yet. We always set the flag afterwards, even on
	// skip/failure, so the user isn't re-prompted on every launch —
	// they can rerun the bootstrap explicitly via --keychain-setup.
	if !cfg.KeychainSetupDone {
		_ = keychain.RunSetup(discoverConfigDirs(*flagRoot))
		cfg.KeychainSetupDone = true
		_ = config.Save(cfg)
	}

	if *flagTui {
		runTui(cfg)
		return
	}

	webOpts, err := resolveWebOptions(*flagLAN, *flagWebHost, *flagAuthToken, *flagLANIP)
	if err != nil {
		die("web options: %v", err)
	}
	if err := runWebOrchestrator(*flagDaemonAddr, *flagWebPort, *flagWebDir, !*flagNoOpen, !*flagNoWeb, *flagRoot, cfg, webOpts); err != nil {
		die("orchestrator: %v", err)
	}
}

// webExposure bundles the LAN-related decisions so runWebOrchestrator
// doesn't have to re-derive them. Resolved once in main() so flag
// validation errors surface before we start the daemon.
type webExposure struct {
	host      string // bind host for Next.js (e.g. "127.0.0.1" or "0.0.0.0")
	authToken string // empty when loopback; set otherwise
	lanIP     string // pre-discovered IPv4 used for LAN URL printing
}

// resolveWebOptions normalizes the LAN-mode flag combinations and
// auto-generates an auth token when the bind is non-loopback. Behaviour:
//
//   - --lan implies --web-host=0.0.0.0 (only when the user kept the default).
//     Doesn't override an explicit --web-host so power users can still pin
//     to a specific interface.
//   - When the resolved host is non-loopback and --auth-token is empty,
//     generate a fresh per-launch token.
//   - Loopback hosts skip auth entirely (the OS already isolates the
//     surface; a token would just be friction during dev).
func resolveWebOptions(lan bool, host, token, lanIP string) (webExposure, error) {
	if lan && host == "127.0.0.1" {
		host = "0.0.0.0"
	}
	exp := webExposure{host: host, authToken: token, lanIP: lanIP}
	if !webx.IsLoopbackHost(host) && exp.authToken == "" {
		t, err := webx.GenerateToken()
		if err != nil {
			return exp, fmt.Errorf("generate auth token: %w", err)
		}
		exp.authToken = t
	}
	if !webx.IsLoopbackHost(host) && exp.lanIP == "" {
		exp.lanIP = webx.LocalIP()
	}
	return exp, nil
}

// discoverConfigDirs is a thin caller-side helper around
// account.ResolveDirs so keychain.RunSetup stays a leaf (no account
// import). Returns nil when discovery fails, matching the behavior
// keychain.RunSetup expects (treats empty as "skip silently").
func discoverConfigDirs(rootSpec string) []string {
	accts, err := account.ResolveDirs(rootSpec)
	if err != nil || len(accts) == 0 {
		return nil
	}
	dirs := make([]string, len(accts))
	for i, a := range accts {
		dirs[i] = a.ConfigDir
	}
	return dirs
}

// runServe boots the daemon and blocks until SIGINT/SIGTERM. The
// keychain-setup bootstrap that gates TUI startup is intentionally
// skipped here — interactive password prompting doesn't fit a
// long-running headless daemon. Run `claude-monitor --keychain-setup`
// once before starting the daemon if swap prompts get noisy.
func runServe(addr, rootSpec string, cfg config.Config) error {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	srv := server.New(rootSpec, cfg, logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	return srv.Start(ctx, addr)
}

// runTui is the legacy terminal dashboard, behind --tui. It does its
// own swap.FetchAll ticker (no daemon), so don't pair it with the
// default daemon+web mode — both would race on the keychain.
func runTui(cfg config.Config) {
	webURL := fmt.Sprintf("http://localhost:%d/", *flagWebPort)
	restart, err := tui.Run(*flagRoot, cfg, version, webURL)
	if err != nil {
		die("tui error: %v", err)
	}
	if restart {
		if err := update.RestartSelf(); err != nil {
			fmt.Fprintf(os.Stderr, "auto-restart failed: %v\nrun `claude-monitor` to use the new version.\n", err)
		}
	}
}

// runWebOrchestrator is the new default mode. It runs the Go daemon in
// a goroutine on the loopback addr, drives the Next.js web server via a
// web.Manager (which supports runtime LAN toggle via daemon endpoints),
// optionally opens the user's browser, and blocks until SIGINT/SIGTERM
// or one of the children dies. On signal, both children get a chance
// to exit gracefully (5s).
func runWebOrchestrator(daemonAddr string, webPort int, webDir string, openBrowser, withWeb bool, rootSpec string, cfg config.Config, exp webExposure) error {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	srv := server.New(rootSpec, cfg, logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	daemonErr := make(chan error, 1)
	go func() { daemonErr <- srv.Start(ctx, daemonAddr) }()

	// Probe daemon health quickly — if it failed to bind (port taken),
	// surfacing the error here is much friendlier than letting the web
	// child come up first and then 502 every request.
	daemonURL := "http://" + daemonAddr
	if err := waitForHealth(ctx, daemonURL+"/api/health", 5*time.Second); err != nil {
		stop()
		<-daemonErr
		return fmt.Errorf("daemon failed to start at %s: %w", daemonAddr, err)
	}
	fmt.Fprintf(os.Stderr, "daemon → %s\n", daemonURL)

	if !withWeb {
		// --no-web: behave like --serve but keep the convenience defaults.
		fmt.Fprintf(os.Stderr, "(web orchestrator skipped — --no-web)\n")
		return <-daemonErr
	}

	mgr := webx.NewManager(webx.Options{
		Port:      webPort,
		WebDir:    webDir,
		DaemonURL: daemonURL,
	}, webx.ManagerOptions{
		BannerOut:   os.Stderr,
		OpenBrowser: openBrowser,
	})

	// Compute initial state from flags + persisted config. Flag-based
	// LAN/Public flips win when set; otherwise we restore whatever was
	// persisted last session.
	app := &appState{}
	lanBind := !webx.IsLoopbackHost(exp.host) || cfg.LANEnabled
	wantPublic := *flagPublic || cfg.PublicEnabled
	authOn := lanBind || wantPublic
	token := exp.authToken
	if token == "" {
		token = cfg.LANToken
	}
	allowIPs := *flagAllowIP
	if allowIPs == "" {
		allowIPs = cfg.AllowIPs
	}
	app.SetAllowIPs(allowIPs)
	// Seed the named-tunnel config from CLI flags first, falling back
	// to the persisted config — same precedence as allowIPs. Empty on
	// both sides means quick tunnel on enable.
	cfTunnelInit := *flagCfTunnel
	if cfTunnelInit == "" {
		cfTunnelInit = cfg.CfTunnelName
	}
	cfHostInit := *flagCfHostname
	if cfHostInit == "" {
		cfHostInit = cfg.CfHostname
	}
	app.SetCfNamed(cfTunnelInit, cfHostInit)
	mgr.SetInitial(webx.InitialState{
		LANBind:  lanBind,
		AuthOn:   authOn,
		Token:    token,
		AllowIPs: allowIPs,
		LANIP:    exp.lanIP,
	})
	app.SetToken(mgr.Status().Token) // remember the (possibly freshly-generated) token

	// Bridges: the daemon's /api/lan/* + /api/public/* handlers call
	// into the manager / cloudflared via these adapters.
	srv.SetLANController(managerBridge{mgr: mgr, app: app})
	srv.SetPublicController(tunnelBridge{mgr: mgr, app: app, port: webPort})

	webErr := make(chan error, 1)
	go func() { webErr <- mgr.Run(ctx) }()

	// Auto-start the tunnel if either --public flag or persisted state
	// asks for it. Don't fail boot on tunnel errors — surface via
	// /api/public/status and let the UI explain (e.g. "cloudflared
	// not installed: install from …").
	if wantPublic {
		go func() {
			ctrl := tunnelBridge{mgr: mgr, app: app, port: webPort}
			status, err := ctrl.Enable(ctx, server.PublicConfig{
				AllowIPs:     allowIPs,
				CfTunnelName: cfg.CfTunnelName,
				CfHostname:   cfg.CfHostname,
			})
			if err != nil {
				fmt.Fprintf(os.Stderr, "public mode: %v\n", err)
				return
			}
			// Persist the (possibly freshly-generated) token so the same
			// QR / bookmarked URL keeps working across restarts. The
			// HTTP enable handler does this for user-driven enables;
			// the auto-start path needs to do it too, otherwise every
			// daemon launch invalidates yesterday's URL.
			if status.Token != "" && status.Token != cfg.LANToken {
				cfg.PublicEnabled = true
				cfg.LANToken = status.Token
				cfg.AllowIPs = allowIPs
				cfg.CfTunnelName = status.CfTunnelName
				cfg.CfHostname = status.CfHostname
				if err := config.Save(cfg); err != nil {
					fmt.Fprintf(os.Stderr, "persist auto-start state: %v\n", err)
				}
			}
		}()
	}

	// stopTunnel cleans up the cloudflared subprocess on shutdown.
	// Tunnel uses an internal long-lived context so it doesn't exit on
	// request-ctx cancellation; the orchestrator's main ctx is the
	// only signal that should tear it down.
	stopTunnel := func() {
		app.mu.Lock()
		tu := app.tunnel
		app.mu.Unlock()
		if tu != nil {
			tu.Stop(5 * time.Second)
		}
	}

	select {
	case <-ctx.Done():
		// Manager observes ctx and stops the child; we just wait.
		stopTunnel()
		<-webErr
		return <-daemonErr
	case err := <-daemonErr:
		// Daemon died unexpectedly; ctx will end web via stop().
		stop()
		stopTunnel()
		<-webErr
		return fmt.Errorf("daemon exited: %w", err)
	case err := <-webErr:
		// Web died unrecoverably (e.g. port collision). Pull daemon down.
		stop()
		stopTunnel()
		dErr := <-daemonErr
		if err != nil {
			return fmt.Errorf("web exited: %w", err)
		}
		return dErr
	}
}

// appState centralizes the cross-cutting orchestrator state that the
// LAN and Public bridges both need to consult — the auth token and
// the IP allowlist live here, not in web.Manager, because each toggle
// needs to know about the other (e.g. disabling LAN while Public is
// still running must keep the auth gate on).
//
// Concurrency: all field reads/writes go through accessor methods that
// take the embedded mutex. The orchestrator is the only writer.
type appState struct {
	mu           sync.Mutex
	allowIPs     string
	cfTunnelName string // empty = quick tunnel; both set = named tunnel
	cfHostname   string
	token        string // last-known good token; preserved across toggles
	tunnel       *tunnel.Tunnel
	setup        *tunnel.Setup // lazily created on first named-tunnel Enable
}

func (a *appState) AllowIPs() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.allowIPs
}

func (a *appState) SetAllowIPs(ips string) {
	a.mu.Lock()
	a.allowIPs = ips
	a.mu.Unlock()
}

// CfNamed returns the persisted named-tunnel config. Both empty means
// "use a quick tunnel"; both set means "use the named tunnel `name`
// routed at `host`". The split (instead of one struct return) matches
// the SetCfNamed setter and avoids allocating a struct on every read.
func (a *appState) CfNamed() (name, host string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cfTunnelName, a.cfHostname
}

func (a *appState) SetCfNamed(name, host string) {
	a.mu.Lock()
	a.cfTunnelName = name
	a.cfHostname = host
	a.mu.Unlock()
}

// PreservedToken returns the last-known token so toggles can keep
// existing QR / bookmarks valid across enable/disable churn. Empty
// when no auth has been on yet (or after an explicit clear).
func (a *appState) PreservedToken() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.token
}

func (a *appState) SetToken(t string) {
	a.mu.Lock()
	a.token = t
	a.mu.Unlock()
}

// PublicRunning reports whether the cloudflared subprocess is
// currently up. Called by managerBridge.Disable to decide if it
// should keep the auth gate on after LAN turns off.
func (a *appState) PublicRunning() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.tunnel != nil && a.tunnel.Status().Running
}

// managerBridge adapts web.Manager (which doesn't import server) to the
// server.LANController interface. Lives in main so neither package has
// to depend on the other beyond its own narrow contract.
//
// Holds a *appState pointer so toggling LAN can preserve the orthogonal
// Public state (and vice versa) — Reconfigure takes the full desired
// state, not a partial update, so the bridge has to keep both in sync.
type managerBridge struct {
	mgr *webx.Manager
	app *appState
}

func (b managerBridge) Status() server.LANStatus {
	return toServerStatus(b.mgr.Status())
}

func (b managerBridge) Enable(ctx context.Context, token string) (server.LANStatus, error) {
	// LAN on: bind 0.0.0.0, auth implicitly on. Preserve current
	// AllowIPs (so the LAN flip doesn't wipe an IP allowlist set
	// alongside Public mode).
	s, err := b.mgr.Reconfigure(ctx, webx.Reconfig{
		LANBind:     true,
		RequireAuth: true,
		Token:       token,
		AllowIPs:    b.app.AllowIPs(),
	})
	return toServerStatus(s), err
}

func (b managerBridge) Disable(ctx context.Context) (server.LANStatus, error) {
	// LAN off, but keep auth on if Public is still active (otherwise
	// the cloudflared tunnel would expose a wide-open Next.js).
	keepAuth := b.app.PublicRunning()
	s, err := b.mgr.Reconfigure(ctx, webx.Reconfig{
		LANBind:     false,
		RequireAuth: keepAuth,
		Token:       b.app.PreservedToken(), // empty when keepAuth=false
		AllowIPs:    b.app.AllowIPs(),
	})
	return toServerStatus(s), err
}

func (b managerBridge) WriteQR(w io.Writer) error {
	s := b.mgr.Status()
	if !s.Enabled || s.LANURL == "" {
		return errors.New("LAN is disabled")
	}
	return webx.WriteSVGQR(w, s.LANURL)
}

// tunnelBridge adapts tunnel.Tunnel + web.Manager to the
// server.PublicController interface. Public exposure has two effects:
//
//  1. Spawn cloudflared so a public URL fronts the loopback Next.js.
//  2. Force the auth gate on (RequireAuth) and apply any IP allowlist.
//
// We keep the auth flip layered on the existing web.Manager so the
// LAN UI shows the gate state consistently regardless of whether it
// was triggered by LAN toggle or Public toggle.
type tunnelBridge struct {
	mgr      *webx.Manager
	app      *appState
	port     int    // Next.js port; cloudflared forwards public traffic here
}

func (b tunnelBridge) Status() server.PublicStatus {
	a := b.app
	a.mu.Lock()
	tu := a.tunnel
	setup := a.setup
	allowIPs := a.allowIPs
	cfTunnel := a.cfTunnelName
	cfHost := a.cfHostname
	a.mu.Unlock()
	token := b.mgr.Status().Token
	var phase string
	if setup != nil {
		phase = string(setup.Phase())
	}
	if tu == nil {
		return server.PublicStatus{
			Enabled:      false,
			AllowIPs:     allowIPs,
			CfTunnelName: cfTunnel,
			CfHostname:   cfHost,
			SetupPhase:   phase,
			Token:        token,
		}
	}
	s := tu.Status()
	// Auto-setup is in flight ⇒ Pending should be true even though no
	// tunnel subprocess is running yet. Otherwise the UI would briefly
	// show "Off" between the Enable click and the tu.Start call,
	// which races against the React polling and can stick.
	pending := (s.Running && !s.Registered) || phase != ""
	enabled := s.Running || phase != ""
	return server.PublicStatus{
		Enabled:      enabled,
		URL:          s.URL,
		Pending:      pending,
		AllowIPs:     allowIPs,
		CfTunnelName: cfTunnel,
		CfHostname:   cfHost,
		SetupPhase:   phase,
		Token:        token,
		Error:        s.Err,
	}
}

func (b tunnelBridge) Enable(ctx context.Context, cfg server.PublicConfig) (server.PublicStatus, error) {
	// 1. Update orchestrator-side state so the manager bridge sees the
	//    new allowlist + named-tunnel config if it gets called
	//    concurrently. CLI flags act as overrides — if the user
	//    launched with --cf-tunnel/--cf-hostname they can't be cleared
	//    via the UI request.
	cfTunnel := cfg.CfTunnelName
	cfHost := cfg.CfHostname
	if *flagCfTunnel != "" {
		cfTunnel = *flagCfTunnel
	}
	if *flagCfHostname != "" {
		cfHost = *flagCfHostname
	}
	b.app.SetAllowIPs(cfg.AllowIPs)
	b.app.SetCfNamed(cfTunnel, cfHost)

	// 2. Recycle Next.js with auth on (preserve existing token if we
	//    have one) + the new allowlist. Don't change LAN bind state —
	//    Public can ride loopback or LAN, doesn't care.
	current := b.mgr.Status()
	token := b.app.PreservedToken()
	if token == "" {
		token = current.Token
	}
	if _, err := b.mgr.Reconfigure(ctx, webx.Reconfig{
		LANBind:     current.Enabled, // keep current bind
		RequireAuth: true,
		Token:       token,
		AllowIPs:    cfg.AllowIPs,
	}); err != nil {
		return server.PublicStatus{}, fmt.Errorf("recycle web for public: %w", err)
	}
	// Capture the (possibly freshly-generated) token so subsequent
	// toggles preserve it.
	b.app.SetToken(b.mgr.Status().Token)

	// 3. Auto-setup the named tunnel if needed (login + create + route
	//    dns). All three are idempotent: cert.pem present ⇒ login is a
	//    no-op; tunnel name already used ⇒ create returns "already
	//    exists" which we treat as success; same for the DNS route.
	//    The login step opens Terminal.app and polls cert.pem so the
	//    user just has to click "Authorize" in the browser. Quick
	//    tunnels skip this entirely.
	if cfTunnel != "" && cfHost != "" {
		b.app.mu.Lock()
		if b.app.setup == nil {
			b.app.setup = tunnel.NewSetup(*flagCloudflared)
		}
		setup := b.app.setup
		b.app.mu.Unlock()

		if err := setup.EnsureLogin(ctx); err != nil {
			return server.PublicStatus{}, fmt.Errorf("cloudflared login: %w", err)
		}
		if err := setup.EnsureTunnel(ctx, cfTunnel); err != nil {
			return server.PublicStatus{}, fmt.Errorf("cloudflared create tunnel: %w", err)
		}
		if err := setup.EnsureRoute(ctx, cfTunnel, cfHost); err != nil {
			return server.PublicStatus{}, fmt.Errorf("cloudflared route dns: %w", err)
		}
	}

	// 4. Start cloudflared. If a tunnel is already running (e.g. from
	//    auto-start at boot, or a previous Enable with different named-
	//    tunnel config), stop it first — Start is no-op when running,
	//    so without an explicit Stop the new Named() call wouldn't
	//    actually take effect on the subprocess. Wait for URL with a
	//    generous timeout (cold tunnels take 5-15s to publish).
	b.app.mu.Lock()
	if b.app.tunnel == nil {
		b.app.tunnel = tunnel.New(*flagCloudflared)
	}
	tu := b.app.tunnel
	b.app.mu.Unlock()

	if tu.Status().Running {
		tu.Stop(8 * time.Second)
	}
	tu.Named(cfTunnel, cfHost)

	localURL := fmt.Sprintf("http://127.0.0.1:%d", b.port)
	if err := tu.Start(ctx, localURL); err != nil {
		return server.PublicStatus{}, fmt.Errorf("start tunnel: %w", err)
	}

	// Return immediately with Pending=true so the response reaches the
	// browser before the manager loop's 250ms grace expires and recycles
	// Next.js (which kills the in-flight response). Cloudflared takes
	// 5-25s to publish the URL; that progress is tracked by the UI via
	// /api/public/status polling, not by blocking this handler.
	//
	// (The previous version called tu.AwaitURL(25s) here, which made the
	// HTTP response race with the recycle and lost — the browser saw a
	// fetch error even though the tunnel was actually starting fine.
	// See feedback_public_enable_response_race.md if you're tempted to
	// re-add the wait.)
	return b.Status(), nil
}

func (b tunnelBridge) Disable(ctx context.Context) (server.PublicStatus, error) {
	b.app.mu.Lock()
	tu := b.app.tunnel
	b.app.mu.Unlock()
	if tu != nil {
		tu.Stop(5 * time.Second)
	}
	// If LAN is also off, drop the auth gate so the loopback browser
	// stops getting 401'd. If LAN is on, keep auth + token in place.
	current := b.mgr.Status()
	keepAuth := current.Enabled // LAN bind ⇒ auth must stay
	token := ""
	if keepAuth {
		token = b.app.PreservedToken()
	}
	if _, err := b.mgr.Reconfigure(ctx, webx.Reconfig{
		LANBind:     current.Enabled,
		RequireAuth: keepAuth,
		Token:       token,
		AllowIPs:    "", // no public ⇒ allowlist isn't doing anything useful; clear it
	}); err != nil {
		return server.PublicStatus{}, err
	}
	b.app.SetAllowIPs("")
	return b.Status(), nil
}

func toServerStatus(s webx.Status) server.LANStatus {
	return server.LANStatus{
		Enabled: s.Enabled,
		Host:    s.Host,
		LANIP:   s.LANIP,
		Port:    s.Port,
		Token:   s.Token,
		URL:     s.URL,
		LANURL:  s.LANURL,
		Pending: s.Pending,
	}
}

// waitForHealth polls /api/health on the daemon URL until it answers
// 200 or the deadline elapses. The daemon's first refresh can take up
// to 30s on networks where /api/oauth/usage is slow, so we check the
// /health route specifically — it's served before the first refresh
// completes.
func waitForHealth(ctx context.Context, url string, timeout time.Duration) error {
	deadline, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	client := &http.Client{Timeout: 500 * time.Millisecond}
	for {
		req, err := http.NewRequestWithContext(deadline, http.MethodGet, url, nil)
		if err == nil {
			res, err := client.Do(req)
			if err == nil {
				_ = res.Body.Close()
				if res.StatusCode == http.StatusOK {
					return nil
				}
			}
		}
		select {
		case <-deadline.Done():
			if errors.Is(deadline.Err(), context.DeadlineExceeded) {
				return errors.New("timed out waiting for /api/health")
			}
			return deadline.Err()
		case <-tick.C:
		}
	}
}

func runUpgrade() error {
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	info, err := update.FetchLatest(ctx)
	if err != nil {
		return err
	}
	if !update.IsNewer(info.LatestTag, version) {
		fmt.Printf("already on latest (%s)\n", version)
		return nil
	}
	fmt.Printf("upgrading %s → %s\n", version, info.LatestTag)
	if err := update.Perform(ctx, info); err != nil {
		return err
	}
	fmt.Printf("✓ upgraded to %s\n", info.LatestTag)
	return nil
}

// runLANOff is the recovery hatch for users who got locked out by the
// LAN auth gate. Two-step flow because the daemon may or may not be
// running:
//
//  1. Best-effort POST /api/lan/disable to the loopback daemon. If a
//     daemon is up it'll recycle Next.js back to loopback and persist
//     the new state itself.
//  2. Always rewrite ~/.claude-monitor/config.json afterwards so a
//     stale-cached daemon (or a fresh launch where no daemon was up)
//     comes back to loopback. Idempotent — safe to run twice.
//
// Step 2 alone is enough if the user is willing to restart the binary;
// step 1 is the "no restart needed" path. We always do both because
// step 1's effect on the running daemon also writes config (so step 2
// is a no-op there), and step 2 alone covers the no-daemon case.
func runLANOff(daemonAddr string) error {
	// Step 1: try daemon. Short timeout — we don't want the kill switch
	// itself to hang on a wedged daemon.
	url := "http://" + daemonAddr + "/api/lan/disable"
	client := &http.Client{Timeout: 3 * time.Second}
	req, err := http.NewRequest(http.MethodPost, url, nil)
	if err == nil {
		res, err := client.Do(req)
		if err == nil {
			_ = res.Body.Close()
			if res.StatusCode == http.StatusOK {
				fmt.Fprintf(os.Stderr, "✓ LAN disabled on running daemon (%s)\n", daemonAddr)
				return nil
			}
			fmt.Fprintf(os.Stderr, "daemon at %s responded %d; falling back to config edit\n", daemonAddr, res.StatusCode)
		} else {
			fmt.Fprintf(os.Stderr, "no daemon at %s (%v); falling back to config edit\n", daemonAddr, err)
		}
	}

	// Step 2: persist disabled state so the next launch comes up clean.
	cfg, _ := config.Load()
	cfg.LANEnabled = false
	cfg.LANToken = ""
	if err := config.Save(cfg); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	fmt.Fprintln(os.Stderr, "✓ ~/.claude-monitor/config.json updated (lanEnabled=false, lanToken cleared)")
	fmt.Fprintln(os.Stderr, "  Restart claude-monitor to apply if a daemon is still running with the old config.")
	return nil
}

func die(format string, a ...any) {
	if !strings.HasSuffix(format, "\n") {
		format += "\n"
	}
	fmt.Fprintf(os.Stderr, format, a...)
	os.Exit(1)
}
