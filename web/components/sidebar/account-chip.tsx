"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronUp, Globe2, Router, Users } from "lucide-react";
import { useDaemonContext } from "@/lib/daemon-context";
import { Progress } from "@/components/ui/progress";
import { AccountsDialog } from "@/components/accounts-dialog";
import { NetworkDialog } from "@/components/network-dialog";
import { OpenRouterDialog } from "@/components/openrouter-dialog";
import { useSidebar } from "@/lib/sidebar-context";

// AccountChip lives at the sidebar bottom. Tapping pops a small menu
// with two entries: the Accounts modal (Claude OAuth identities,
// quotas, swaps) and the Network dialog (LAN + Cloudflare tunnel).
// Splitting the two halves keeps each modal short enough to read on a
// phone — the combined view was getting unwieldy.
//
// Implementation note: we hand-roll the dropdown instead of using
// base-ui's Popover because the slot/render API was swallowing clicks
// in this exact spot (sidebar footer, button-as-trigger with custom
// children). A 30-line absolute-position menu with an outside-click
// handler is plenty for two entries and dodges the issue entirely.
export function AccountChip() {
  const { snapshot, status } = useDaemonContext();
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [networkOpen, setNetworkOpen] = useState(false);
  const [openRouterOpen, setOpenRouterOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { setOpen: setSidebarOpen, isMobile } = useSidebar();

  const active = snapshot?.accounts.find((a) => a.active);
  const initial = (active?.name ?? "?").slice(0, 1).toUpperCase();
  const utilPct =
    active?.five_hour ? Math.round(active.five_hour.utilization) : null;

  // Close on outside click / Escape so the dropdown behaves like the
  // base-ui popover would. Both listeners are removed when the menu
  // closes so we don't keep a global handler around at idle.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (e: PointerEvent) => {
      const root = wrapperRef.current;
      if (root && !root.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const openDialog = (which: "accounts" | "network" | "openrouter") => {
    setMenuOpen(false);
    if (which === "accounts") setAccountsOpen(true);
    else if (which === "network") setNetworkOpen(true);
    else setOpenRouterOpen(true);
    // Mobile: dismiss the drawer when the user picks a setting so the
    // dialog isn't fighting the sidebar for screen space.
    if (isMobile) setSidebarOpen(false);
  };

  return (
    <>
      <div ref={wrapperRef} className="relative">
        <button
          type="button"
          aria-label="Open settings"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
          className="group flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent focus-visible:bg-sidebar-accent focus-visible:outline-none"
        >
          <span className="relative">
            <span className="flex size-8 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
              {initial}
            </span>
            <span
              aria-hidden
              className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-sidebar ${
                status === "open"
                  ? "bg-emerald-500"
                  : status === "connecting"
                    ? "bg-amber-500"
                    : "bg-destructive"
              }`}
            />
          </span>
          <span className="block min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {active?.name ?? "No active account"}
            </span>
            {utilPct !== null ? (
              <span className="flex items-center gap-1.5">
                <Progress value={Math.min(utilPct, 100)} className="h-1 flex-1" />
                <span className="tabular-nums text-[10px] text-muted-foreground">
                  {utilPct}%
                </span>
              </span>
            ) : (
              <span className="block truncate text-[11px] text-muted-foreground">
                {snapshot
                  ? `${snapshot.accounts.length} account${snapshot.accounts.length === 1 ? "" : "s"}`
                  : status === "error"
                    ? "Daemon offline"
                    : "Connecting…"}
              </span>
            )}
          </span>
          <ChevronUp
            className={`size-4 shrink-0 opacity-60 transition-transform group-hover:opacity-100 ${
              menuOpen ? "rotate-180" : ""
            }`}
          />
        </button>

        {menuOpen && (
          <div
            role="menu"
            // bottom-full anchors the menu directly above the chip
            // (sidebar footer); left-0 right-0 makes it span the chip's
            // width so it feels visually attached. mb-1.5 is the gap
            // between menu and chip; shadow-lg + ring matches base-ui's
            // popover styling so the visual language is consistent.
            className="absolute right-0 bottom-full left-0 z-50 mb-1.5 rounded-lg bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
          >
            <MenuItem
              icon={<Users className="size-4" aria-hidden />}
              label="Accounts"
              description={
                snapshot
                  ? `${snapshot.accounts.length} account${snapshot.accounts.length === 1 ? "" : "s"} · swap, login, quotas`
                  : "Manage Claude OAuth identities"
              }
              onClick={() => openDialog("accounts")}
            />
            <MenuItem
              icon={<Router className="size-4" aria-hidden />}
              label="OpenRouter"
              description="Route sessions through OpenRouter to swap models"
              onClick={() => openDialog("openrouter")}
            />
            <MenuItem
              icon={<Globe2 className="size-4" aria-hidden />}
              label="Network access"
              description="Expose to LAN or via Cloudflare tunnel"
              onClick={() => openDialog("network")}
            />
          </div>
        )}
      </div>
      <AccountsDialog open={accountsOpen} onOpenChange={setAccountsOpen} />
      <NetworkDialog open={networkOpen} onOpenChange={setNetworkOpen} />
      <OpenRouterDialog
        open={openRouterOpen}
        onOpenChange={setOpenRouterOpen}
      />
    </>
  );
}

function MenuItem({
  icon,
  label,
  description,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
    >
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}
