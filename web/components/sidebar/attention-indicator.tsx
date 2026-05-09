"use client";

import { useEffect, useRef } from "react";
import { useSessions } from "@/lib/sessions-context";

// AttentionIndicator paints two ambient signals when one or more
// sessions need the user's attention (awaiting permission / pending
// AskUserQuestion):
//
// 1. Document title prefix: `(N) claude-monitor` — by far the most
//    visible bit of UI when the tab is in the background, since
//    browsers truncate the title hard but always keep the prefix.
// 2. Favicon badge: a small red circle in the top-right of the icon
//    with the count baked in. Painted into a 64x64 canvas and pushed
//    via <link rel="icon"> at runtime; survives reloads naturally
//    because we recompute on every count change.
//
// The component renders nothing — it just runs effects. Mount it once,
// inside SessionsProvider, and forget about it.
export function AttentionIndicator() {
  const { sessions } = useSessions();
  const baseTitleRef = useRef<string | null>(null);

  // Count sessions that need the user. awaiting_permission covers BOTH
  // tool permission prompts and AskUserQuestion forms — both pin the
  // session status to that value server-side. We deliberately don't
  // count "errored" so the badge stays a "you must act" cue rather
  // than a noisy diagnostic.
  const count = sessions.filter((s) => s.status === "awaiting_permission")
    .length;

  // Cache the original document title once (typically set via the
  // <title> in app/layout.tsx). Restoring it on count→0 avoids leaving
  // a stale `(0)` prefix.
  useEffect(() => {
    if (baseTitleRef.current === null) {
      const title = document.title || "claude-monitor";
      baseTitleRef.current = title.replace(/^\(\d+\)\s*/, "");
    }
  }, []);

  // Update title prefix.
  useEffect(() => {
    const base = baseTitleRef.current ?? "claude-monitor";
    document.title = count > 0 ? `(${count}) ${base}` : base;
  }, [count]);

  // Update favicon. Skip during SSR + in environments that block
  // canvas (some hardened browsers / extensions); the title prefix is
  // sufficient signal on its own.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const dataUrl = paintFavicon(count);
    if (!dataUrl) return;
    setFaviconHref(dataUrl);
    return () => {
      // On unmount restore a plain favicon. Most users navigate within
      // the SPA so this rarely fires; mainly here to not leave a
      // counter behind during HMR in dev.
      const restore = paintFavicon(0);
      if (restore) setFaviconHref(restore);
    };
  }, [count]);

  return null;
}

// paintFavicon renders the badge into a 64x64 canvas. The base mark is
// a square card with a stylised "C" so the shape stays recognisable
// at 16x16. The counter overlays the top-right corner when count > 0.
// Returns the PNG data URL or null if the runtime can't paint.
function paintFavicon(count: number): string | null {
  try {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // Card background — rounded square in the brand orange/amber
    // family. Matches the app accent enough that swapping themes
    // doesn't make the favicon look out of place.
    const r = 12;
    ctx.fillStyle = "#0f172a"; // slate-900
    roundRect(ctx, 0, 0, size, size, r);
    ctx.fill();

    // "C" mark.
    ctx.fillStyle = "#f5f5f4"; // stone-100
    ctx.font = "bold 42px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("C", size / 2 - 2, size / 2 + 2);

    if (count > 0) {
      // Badge: red circle with the count. Position top-right; clip a
      // tiny ring of the base color around it so the badge stays
      // legible against any backdrop.
      const cx = size - 16;
      const cy = 16;
      const radius = 14;
      ctx.fillStyle = "#0f172a";
      ctx.beginPath();
      ctx.arc(cx, cy, radius + 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ef4444"; // red-500
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 20px system-ui, -apple-system, Segoe UI, sans-serif";
      ctx.fillText(count > 9 ? "9+" : String(count), cx, cy + 1);
    }

    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function setFaviconHref(href: string): void {
  // Prefer existing <link rel="icon"> nodes so we don't leave duplicates
  // behind on hot reloads. If the page hasn't shipped one we create a
  // single new node and hold onto it via the data attribute.
  let link = document.querySelector<HTMLLinkElement>(
    "link[rel='icon'][data-cm-favicon]",
  );
  if (!link) {
    // Replace ALL existing favicons (next ships an opaque default that
    // would otherwise win in some browsers). Tag the survivor so we
    // can find it next time.
    document
      .querySelectorAll("link[rel='icon'], link[rel='shortcut icon']")
      .forEach((n) => n.parentElement?.removeChild(n));
    link = document.createElement("link");
    link.rel = "icon";
    link.dataset.cmFavicon = "1";
    document.head.appendChild(link);
  }
  link.type = "image/png";
  link.href = href;
}
