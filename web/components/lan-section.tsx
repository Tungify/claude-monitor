"use client";

// Network access section in AccountsDialog. Two orthogonal toggles:
//
//   - LAN: Next.js binds 0.0.0.0 + token gate. Phones on the same
//     Wi-Fi can reach the URL.
//   - Public: cloudflared spawns a `*.trycloudflare.com` tunnel back
//     to loopback Next.js. Auth gate is auto-enabled (otherwise the
//     public URL would be wide open). Optional IP allowlist as
//     defense-in-depth against token leakage.
//
// Browser tab survival across toggles:
//   - On LAN/Public enable from a loopback session, we redirect to
//     /?token=<token> after the API call so proxy.ts first-touch
//     sets the cookie. Without this, the next fetch would 401.
//   - On disable, we reload to clear stale cookies (cosmetic; the
//     cookie is harmless when the gate is off).
//
// QR uses an SVG endpoint on the daemon (image/svg+xml) so we don't
// have to ship a JS QR library. Same-origin via the /daemon proxy →
// the gate cookie covers it for free.

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Copy,
  Globe,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  fetchLANStatus,
  enableLAN,
  disableLAN,
  fetchPublicStatus,
  enablePublic,
  disablePublic,
  lanQRURL,
  type LANStatus,
  type PublicStatus,
} from "@/lib/daemon";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// Polling interval while a public tunnel is starting up. cloudflared
// usually publishes the URL within 2-5s but cold edge picks can stretch
// to 15s — we poll at 1s so the UI reflects the URL the moment it
// appears without thrashing the daemon.
const PENDING_POLL_MS = 1000;

export function LANSection() {
  const [lan, setLan] = useState<LANStatus | null>(null);
  const [pub, setPub] = useState<PublicStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lanBusy, setLanBusy] = useState(false);
  const [pubBusy, setPubBusy] = useState(false);
  // allowInput is the working-copy of the IP allowlist while the user
  // is editing. Persisted to daemon only on enable/save click — we
  // don't recycle Next.js on every keystroke.
  const [allowInput, setAllowInput] = useState("");
  // cfTunnelInput / cfHostInput are the working copies for the named
  // tunnel — same reason as allowInput. Both empty = quick tunnel
  // (the *.trycloudflare.com path, but SSE breaks); both set = named
  // tunnel (the user has run `cloudflared tunnel login/create/route
  // dns` once).
  const [cfTunnelInput, setCfTunnelInput] = useState("");
  const [cfHostInput, setCfHostInput] = useState("");
  const [qrTick, setQrTick] = useState(0);

  // Initial fetch + soft-hide on --serve mode (501 from daemon).
  useEffect(() => {
    const ac = new AbortController();
    Promise.all([
      fetchLANStatus(ac.signal),
      fetchPublicStatus(ac.signal).catch(() => null), // public optional
    ])
      .then(([l, p]) => {
        setLan(l);
        if (p) {
          setPub(p);
          setAllowInput(p.allow_ips ?? "");
          setCfTunnelInput(p.cf_tunnel_name ?? "");
          setCfHostInput(p.cf_hostname ?? "");
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => ac.abort();
  }, []);

  // Poll public status while pending. Stops once URL appears or
  // tunnel goes down. Self-cancels on unmount via the cleanup return.
  useEffect(() => {
    if (!pub?.pending) return;
    const ac = new AbortController();
    const id = setInterval(async () => {
      try {
        const next = await fetchPublicStatus(ac.signal);
        setPub(next);
        if (!next.pending) clearInterval(id);
      } catch {
        // network blip — keep polling, don't surface as an error
      }
    }, PENDING_POLL_MS);
    return () => {
      ac.abort();
      clearInterval(id);
    };
  }, [pub?.pending]);

  const onLanEnable = useCallback(async () => {
    setLanBusy(true);
    setError(null);
    try {
      const fresh = await enableLAN();
      setLan(fresh);
      setQrTick((n) => n + 1);
      if (fresh.token) {
        // Hard navigation to set the cookie via proxy.ts first-touch.
        window.location.href = `/?token=${encodeURIComponent(fresh.token)}`;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLanBusy(false);
    }
  }, []);

  const onLanDisable = useCallback(async () => {
    setLanBusy(true);
    setError(null);
    try {
      const fresh = await disableLAN();
      setLan(fresh);
      setQrTick((n) => n + 1);
      // If Public is still on, the auth gate is still required —
      // cookie stays valid, no reload needed. Otherwise reload to
      // clear stale cookies for a clean state.
      if (!pub?.enabled) {
        window.location.reload();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLanBusy(false);
    }
  }, [pub?.enabled]);

  const onPubEnable = useCallback(async () => {
    setPubBusy(true);
    setError(null);
    // Optimistically flip pub.pending=true so the UI shows "Starting
    // tunnel…" + the polling effect (gated on pub?.pending) takes over
    // immediately. We do this BEFORE the await because the enable
    // request itself can fail mid-flight: the daemon recycles Next.js
    // to apply MONITOR_AUTH_TOKEN, which severs the in-flight response
    // even though the tunnel is actually starting fine on the server.
    // Polling fetches /api/public/status until ground truth arrives.
    // Don't preserve prev.url — the user may have just switched from
    // quick → named tunnel (or vice versa), and showing the previous
    // URL during the restart would be misleading. The polling effect
    // fills in the fresh URL once the server confirms the tunnel is
    // up.
    setPub({
      enabled: true,
      pending: true,
      allow_ips: allowInput.trim() || undefined,
      cf_tunnel_name: cfTunnelInput.trim() || undefined,
      cf_hostname: cfHostInput.trim() || undefined,
    });
    try {
      const fresh = await enablePublic({
        allowIPs: allowInput.trim(),
        cfTunnelName: cfTunnelInput.trim(),
        cfHostname: cfHostInput.trim(),
      });
      setPub(fresh);
      // Public toggle also flips the auth gate on, so loopback
      // sessions need the token cookie afterwards. Refresh LAN status
      // first to grab the (possibly newly-generated) token, then
      // redirect with ?token= to re-trigger the cookie set. Wrapped in
      // try/catch — fetch may be in flight while the proxy recycles,
      // and the polling effect catches up either way.
      try {
        const lanFresh = await fetchLANStatus();
        setLan(lanFresh);
        if (
          lanFresh.auth_enabled &&
          lanFresh.token &&
          !document.cookie.includes("cm_token=")
        ) {
          window.location.href = `/?token=${encodeURIComponent(lanFresh.token)}`;
        }
      } catch {
        // proxy recycle in flight — polling resolves it
      }
    } catch (e) {
      // Distinguish a network blip (proxy recycle severed the request,
      // tunnel still starting) from a real server error. TypeError
      // "Failed to fetch" is the canonical browser network error;
      // server-reported failures come back as Error with the message
      // from the daemon's JSON body.
      const msg = e instanceof Error ? e.message : String(e);
      const isNetwork =
        msg === "Failed to fetch" ||
        msg.toLowerCase().includes("networkerror") ||
        msg.toLowerCase().includes("load failed");
      if (!isNetwork) {
        setError(msg);
      }
      // Either way, leave pub.pending=true so polling resolves the
      // ground truth — for the network case the tunnel is starting,
      // for a hard server error the next poll will return enabled=
      // false and pending=false, and the polling effect stops.
    } finally {
      setPubBusy(false);
    }
  }, [allowInput, cfTunnelInput, cfHostInput]);

  const onPubDisable = useCallback(async () => {
    setPubBusy(true);
    setError(null);
    try {
      const fresh = await disablePublic();
      setPub(fresh);
      // Refresh LAN status — disabling Public drops the gate when LAN
      // is also off, which means the cookie becomes vestigial.
      const lanFresh = await fetchLANStatus();
      setLan(lanFresh);
      if (!lanFresh.auth_enabled) {
        window.location.reload();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPubBusy(false);
    }
  }, []);

  // Hide the entire section on --serve mode (no orchestrator).
  if (error && error.includes("not available in --serve mode")) {
    return null;
  }

  return (
    <section className="space-y-3 rounded-lg border bg-card p-3">
      <h3 className="text-sm font-medium">Network access</h3>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Network toggle failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <LANRow
        status={lan}
        busy={lanBusy}
        onEnable={onLanEnable}
        onDisable={onLanDisable}
        qrTick={qrTick}
      />

      <hr className="border-border/60" />

      <PublicRow
        status={pub}
        lanStatus={lan}
        busy={pubBusy}
        allowInput={allowInput}
        onAllowInputChange={setAllowInput}
        cfTunnelInput={cfTunnelInput}
        onCfTunnelInputChange={setCfTunnelInput}
        cfHostInput={cfHostInput}
        onCfHostInputChange={setCfHostInput}
        onEnable={onPubEnable}
        onDisable={onPubDisable}
      />
    </section>
  );
}

function LANRow({
  status,
  busy,
  onEnable,
  onDisable,
  qrTick,
}: {
  status: LANStatus | null;
  busy: boolean;
  onEnable: () => void;
  onDisable: () => void;
  qrTick: number;
}) {
  return (
    <div className="space-y-2">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {status?.enabled ? (
            <Wifi className="size-4 text-emerald-500" aria-hidden />
          ) : (
            <WifiOff className="size-4 text-muted-foreground" aria-hidden />
          )}
          <div>
            <p className="text-sm font-medium">LAN (same Wi-Fi)</p>
            <p className="text-xs text-muted-foreground">
              {status?.enabled
                ? "Reachable from any device on your local network."
                : "Loopback only. Phone on the same Wi-Fi can't see this."}
            </p>
          </div>
        </div>
        {status && (
          <Button
            size="sm"
            variant={status.enabled ? "outline" : "default"}
            disabled={busy}
            onClick={status.enabled ? onDisable : onEnable}
          >
            {busy && <RefreshCw className="mr-1 size-3.5 animate-spin" />}
            {!busy && <Smartphone className="mr-1 size-3.5" />}
            {status.enabled ? "Disable" : "Enable for phone"}
          </Button>
        )}
      </header>
      {status?.enabled && status.lan_url && (
        <LANDetails url={status.lan_url} ip={status.lan_ip} qrTick={qrTick} />
      )}
    </div>
  );
}

function PublicRow({
  status,
  lanStatus,
  busy,
  allowInput,
  onAllowInputChange,
  cfTunnelInput,
  onCfTunnelInputChange,
  cfHostInput,
  onCfHostInputChange,
  onEnable,
  onDisable,
}: {
  status: PublicStatus | null;
  lanStatus: LANStatus | null;
  busy: boolean;
  allowInput: string;
  onAllowInputChange: (v: string) => void;
  cfTunnelInput: string;
  onCfTunnelInputChange: (v: string) => void;
  cfHostInput: string;
  onCfHostInputChange: (v: string) => void;
  onEnable: () => void;
  onDisable: () => void;
}) {
  const tunnelTrim = cfTunnelInput.trim();
  const hostTrim = cfHostInput.trim();
  const namedTunnelOK = tunnelTrim !== "" && hostTrim !== "";
  // partialNamed = exactly one of name/host is filled. We can't run a
  // named tunnel with only the hostname (cloudflared needs the tunnel
  // name to look up credentials in ~/.cloudflared/<UUID>.json) and we
  // shouldn't silently fall back to a quick tunnel — the user clearly
  // intended a specific public hostname, and ending up at a random
  // *.trycloudflare.com URL is confusing.
  const partialNamed =
    !namedTunnelOK && (tunnelTrim !== "" || hostTrim !== "");
  // Public requires the orchestrator endpoint; if status is null we
  // either failed to fetch or the daemon is in --serve mode. The
  // outer LANSection already filters --serve, so a null here is most
  // likely "still loading".
  if (!status) {
    return (
      <div className="text-xs text-muted-foreground">Loading public status…</div>
    );
  }

  return (
    <div className="space-y-2">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Globe
            className={`size-4 ${
              status.enabled ? "text-emerald-500" : "text-muted-foreground"
            }`}
            aria-hidden
          />
          <div>
            <p className="text-sm font-medium">Public (Cloudflare Tunnel)</p>
            <p className="text-xs text-muted-foreground">
              {status.enabled
                ? status.pending
                  ? status.cf_hostname
                    ? `Starting tunnel for ${status.cf_hostname}…`
                    : "Starting tunnel…"
                  : status.cf_hostname
                    ? `Reachable at ${status.cf_hostname} via your named Cloudflare tunnel.`
                    : "Reachable from anywhere via a *.trycloudflare.com URL (quick tunnel — SSE may buffer)."
                : "Off. Use this to access from a different network (e.g. mobile data)."}
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant={status.enabled ? "outline" : "default"}
          disabled={busy || (!status.enabled && partialNamed)}
          onClick={status.enabled ? onDisable : onEnable}
        >
          {busy && <RefreshCw className="mr-1 size-3.5 animate-spin" />}
          {!busy && <Globe className="mr-1 size-3.5" />}
          {status.enabled ? "Disable" : "Enable public"}
        </Button>
      </header>

      {status.error && status.error.includes("not found") && (
        <Alert variant="destructive">
          <AlertTitle>cloudflared not installed</AlertTitle>
          <AlertDescription>
            Install from{" "}
            <a
              href="https://developers.cloudflare.com/cloudflared/"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              developers.cloudflare.com/cloudflared
            </a>
            , then retry. macOS: <code>brew install cloudflared</code>.
          </AlertDescription>
        </Alert>
      )}

      {!status.enabled && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              Named tunnel (recommended for SSE)
            </label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input
                type="text"
                value={cfTunnelInput}
                onChange={(e) => onCfTunnelInputChange(e.target.value)}
                placeholder="tunnel name (e.g. monitor)"
                className="w-full rounded border bg-background px-2 py-1.5 font-mono text-xs sm:py-1"
              />
              <input
                type="text"
                value={cfHostInput}
                onChange={(e) => onCfHostInputChange(e.target.value)}
                placeholder="hostname (e.g. monitor.example.com)"
                className="w-full rounded border bg-background px-2 py-1.5 font-mono text-xs sm:py-1"
              />
            </div>
            {partialNamed ? (
              <p className="flex items-start gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {tunnelTrim === ""
                  ? "Tunnel name is required when a hostname is set — cloudflared looks up credentials by name. Leave both fields empty to fall back to a quick tunnel (random *.trycloudflare.com URL)."
                  : "Hostname is required when a tunnel name is set. Leave both fields empty to fall back to a quick tunnel (random *.trycloudflare.com URL)."}
              </p>
            ) : namedTunnelOK ? (
              <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
                Will use named tunnel <code className="font-mono">{tunnelTrim}</code>{" "}
                routed at <code className="font-mono">{hostTrim}</code>.
              </p>
            ) : (
              <details className="text-[11px] text-muted-foreground">
                <summary className="cursor-pointer select-none underline-offset-2 hover:underline">
                  Empty = quick tunnel (no setup, but UI may show empty
                  account list — Cloudflare buffers SSE on quick tunnels).
                  Click to see one-time setup for a named tunnel.
                </summary>
                <ol className="mt-1.5 ml-4 list-decimal space-y-1">
                  <li>
                    Run <code className="font-mono">cloudflared tunnel login</code>{" "}
                    in a terminal — opens a browser to pick the domain you've
                    added to Cloudflare.
                  </li>
                  <li>
                    Run{" "}
                    <code className="font-mono">
                      cloudflared tunnel create &lt;name&gt;
                    </code>{" "}
                    to provision the tunnel (the name goes in the left
                    field).
                  </li>
                  <li>
                    Run{" "}
                    <code className="font-mono">
                      cloudflared tunnel route dns &lt;name&gt; &lt;hostname&gt;
                    </code>{" "}
                    to point a DNS record at the tunnel (the hostname goes
                    in the right field).
                  </li>
                  <li>Fill both fields above and click Enable.</li>
                </ol>
              </details>
            )}
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              IP allowlist (optional, recommended)
            </label>
            <input
              type="text"
              value={allowInput}
              onChange={(e) => onAllowInputChange(e.target.value)}
              placeholder="e.g. 203.0.113.7,2001:db8::/32"
              // py-1.5 on mobile gives a 36px tap target; sm reverts to
              // dense desktop sizing.
              className="w-full rounded border bg-background px-2 py-1.5 font-mono text-xs sm:py-1"
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated IPs / CIDR ranges. Empty = token-only (anyone
              with the URL can connect).
            </p>
            {!allowInput.trim() && (
              <p className="flex items-start gap-1 text-xs text-amber-600 dark:text-amber-400">
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                Without an IP allowlist, a leaked URL gives anyone full
                access to your Claude accounts and your machine&apos;s chat
                sessions.
              </p>
            )}
          </div>
        </div>
      )}

      {status.enabled && !status.pending && status.url && (
        <PublicDetails
          url={status.url}
          token={lanStatus?.token}
          allowIPs={status.allow_ips}
        />
      )}
      {status.enabled && status.pending && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <RefreshCw className="size-3 animate-spin" aria-hidden />
          Tunnel registering with Cloudflare edge — typically 5-15s, can
          stretch to 60-90s on slow DNS. Public URL returns Error 1033
          until this completes.
        </p>
      )}
      {status.enabled && lanStatus?.token && status.url && (
        <p className="text-[11px] text-muted-foreground">
          Append{" "}
          <code className="font-mono">
            ?token={lanStatus.token.slice(0, 6)}…
          </code>{" "}
          to the public URL to auto-set the cookie on a new device. Use the
          copy button — it includes the token already.
        </p>
      )}
    </div>
  );
}

function LANDetails({
  url,
  ip,
  qrTick,
}: {
  url: string;
  ip?: string;
  qrTick: number;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard might be denied; URL is shown next to the button.
    }
  };

  return (
    <div className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-start">
      <img
        src={`${lanQRURL()}?v=${qrTick}`}
        alt="QR code for LAN URL"
        className="h-36 w-36 rounded border bg-white p-1 dark:bg-white"
      />
      <div className="min-w-0 space-y-2">
        <div>
          <div className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
            URL (open on phone)
          </div>
          <div className="flex items-center gap-1.5">
            <code className="block min-w-0 flex-1 truncate rounded border bg-muted px-2 py-1 font-mono text-xs">
              {url}
            </code>
            <Button
              size="sm"
              variant="ghost"
              onClick={onCopy}
              className="shrink-0"
              aria-label={copied ? "Copied" : "Copy URL"}
            >
              {copied ? (
                <Check className="size-3.5 text-emerald-500" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </Button>
          </div>
        </div>
        {ip && (
          <p className="text-xs text-muted-foreground">
            Phone &amp; computer must share the same Wi-Fi. Detected interface:{" "}
            <code className="font-mono">{ip}</code>.
          </p>
        )}
      </div>
    </div>
  );
}

function PublicDetails({
  url,
  token,
  allowIPs,
}: {
  url: string;
  token?: string;
  allowIPs?: string;
}) {
  const [copied, setCopied] = useState(false);

  // Display the bare URL (clean, fits the box) but copy the
  // tokenized form so the user can paste it into a new browser
  // and have proxy.ts set the cookie on first touch. The hint
  // text below promises this — keep them in sync.
  const copyValue = token ? `${url}?token=${encodeURIComponent(token)}` : url;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(copyValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // see LANDetails
    }
  };

  return (
    <div className="space-y-2">
      <div className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        Public URL
      </div>
      <div className="flex items-center gap-1.5">
        <code className="block min-w-0 flex-1 truncate rounded border bg-muted px-2 py-1 font-mono text-xs">
          {url}
        </code>
        <Button
          size="sm"
          variant="ghost"
          onClick={onCopy}
          className="shrink-0"
          aria-label={copied ? "Copied" : "Copy URL"}
        >
          {copied ? (
            <Check className="size-3.5 text-emerald-500" />
          ) : (
            <Copy className="size-3.5" />
          )}
        </Button>
      </div>
      {allowIPs && (
        <p className="text-xs text-muted-foreground">
          IP allowlist active:{" "}
          <code className="font-mono text-xs">{allowIPs}</code>
        </p>
      )}
    </div>
  );
}
