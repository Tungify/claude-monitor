"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Check, Code, Copy, Maximize2, RotateCcw, X } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface Props {
  source: string;
}

// Lazy-import mermaid to keep its ~500KB bundle out of first paint. The
// renderer mounts once per code block and replaces the placeholder div
// with the SVG. We never re-render in place — if `source` changes (rare,
// streaming edits) we force a fresh mount via a key in the parent.
export function MermaidBlock({ source }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [view, setView] = useState<"svg" | "raw">("svg");
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        // startOnLoad: false — we own the lifecycle; calling render()
        // directly avoids mermaid scanning the whole DOM each mount.
        mermaid.initialize({
          startOnLoad: false,
          theme: "default",
          securityLevel: "strict",
          fontFamily: "var(--font-sans)",
        });
        const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`;
        const { svg } = await mermaid.render(id, source);
        if (!cancelled) setSvg(svg);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source]);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Some browsers refuse clipboard access without HTTPS or a user
      // gesture. The click that triggered us IS a gesture, so this
      // should only fail in non-secure contexts — silently ignore.
    }
  }, [source]);

  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
        <div className="mb-1 font-medium">Mermaid render failed</div>
        <pre className="whitespace-pre-wrap">{error}</pre>
        <pre className="mt-2 whitespace-pre-wrap rounded bg-background p-2 font-mono text-[11px] text-foreground">
          {source}
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
        Rendering diagram…
      </div>
    );
  }

  return (
    <>
      <div className="group relative rounded-md border bg-card">
        <Toolbar
          view={view}
          onToggleView={() =>
            setView((v) => (v === "svg" ? "raw" : "svg"))
          }
          onFullscreen={() => setFullscreenOpen(true)}
          onCopy={onCopy}
          copied={copied}
        />
        {view === "svg" ? (
          <div
            className="overflow-auto p-3 [&_svg]:mx-auto [&_svg]:max-w-full"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <pre className="overflow-auto p-3 font-mono text-[11.5px] leading-relaxed">
            {source}
          </pre>
        )}
      </div>
      <Dialog
        open={fullscreenOpen}
        onOpenChange={(o) => setFullscreenOpen(o)}
      >
        <DialogContent
          showCloseButton={false}
          // Inset-4 panel — same shape the SQL playground's fullscreen
          // uses. Centred via DialogContent's default top-1/2 / left-
          // 1/2 / -translate transform; the !w-/!h-calc gives the
          // 1rem breathing room from each viewport edge.
          className="flex !h-[calc(100dvh-2rem)] !w-[calc(100vw-2rem)] !max-w-none flex-col overflow-hidden !rounded-lg !p-0 !gap-0 shadow-2xl"
        >
          {/* No `{fullscreenOpen && ...}` guard — DialogContent itself
              only lives in the tree while the Dialog is open (or
              animating closed), so FullscreenViewer naturally stays
              mounted through the fade-out instead of vanishing mid-
              animation. */}
          <FullscreenViewer
            svg={svg}
            source={source}
            onCopy={onCopy}
            copied={copied}
            onClose={() => setFullscreenOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function Toolbar({
  view,
  onToggleView,
  onFullscreen,
  onCopy,
  copied,
}: {
  view: "svg" | "raw";
  onToggleView: () => void;
  onFullscreen: () => void;
  onCopy: () => void;
  copied: boolean;
}) {
  return (
    <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-0.5 rounded-md border bg-background/85 p-0.5 opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <ToolbarBtn
        label="Fullscreen"
        onClick={onFullscreen}
        icon={<Maximize2 className="size-3.5" />}
      />
      <ToolbarBtn
        label={view === "svg" ? "Show source" : "Show diagram"}
        onClick={onToggleView}
        icon={<Code className="size-3.5" />}
        active={view === "raw"}
      />
      <ToolbarBtn
        label={copied ? "Copied!" : "Copy source"}
        onClick={onCopy}
        icon={
          copied ? (
            <Check className="size-3.5 text-emerald-500" />
          ) : (
            <Copy className="size-3.5" />
          )
        }
      />
    </div>
  );
}

function ToolbarBtn({
  label,
  onClick,
  icon,
  active,
}: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground",
        active && "bg-muted text-foreground",
      )}
    >
      {icon}
    </button>
  );
}

// Zoom bounds. Mermaid SVGs typically have small intrinsic sizes so we
// allow generous upward room; the lower bound just keeps the diagram
// from disappearing into a single pixel.
const MIN_SCALE = 0.2;
const MAX_SCALE = 12;
// Higher = snappier wheel zoom. 0.004 means ~1 mouse notch → ~45% zoom
// step, vs trackpad pinch (~10 deltaY) → ~4% step — both feel right.
const ZOOM_SENSITIVITY = 0.004;
// Per-keypress pan distance in screen pixels. Arrow keys shove the
// canvas by a chunk so reaching the edge doesn't take twenty taps.
const KEY_PAN_STEP = 80;
// Keyboard zoom step. +/- give a perceptible jump, not a creep.
const KEY_ZOOM_STEP = 1.25;

function FullscreenViewer({
  svg,
  source,
  onCopy,
  copied,
  onClose,
}: {
  svg: string;
  source: string;
  onCopy: () => void;
  copied: boolean;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  // Live transform state lives in a ref so pan/zoom can write straight
  // to the DOM (innerRef.style.transform) every mouse event without
  // bouncing through React. setScaleDisplay only fires for the toolbar
  // % readout, which can lag a frame without anyone noticing.
  const tRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const [scaleDisplay, setScaleDisplay] = useState(1);
  const [view, setView] = useState<"svg" | "raw">("svg");

  const applyTransform = useCallback(() => {
    const i = innerRef.current;
    if (!i) return;
    const { scale, tx, ty } = tRef.current;
    i.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }, []);

  // Natural (untransformed) size of the inner element. We read once
  // when scale is exactly 1 (initial mount), then back-derive from the
  // current bbox / scale on subsequent calls. Caching in a ref avoids
  // a layout thrash every reset.
  const naturalSizeRef = useRef<{ w: number; h: number } | null>(null);
  const measureNatural = () => {
    const i = innerRef.current;
    if (!i) return null;
    if (naturalSizeRef.current) return naturalSizeRef.current;
    const ir = i.getBoundingClientRect();
    const { scale } = tRef.current;
    const size = { w: ir.width / scale, h: ir.height / scale };
    naturalSizeRef.current = size;
    return size;
  };

  const centerAtScale = useCallback(
    (newScale: number) => {
      const c = containerRef.current;
      const size = measureNatural();
      if (!c || !size) return;
      const cr = c.getBoundingClientRect();
      tRef.current = {
        scale: newScale,
        tx: (cr.width - size.w * newScale) / 2,
        ty: (cr.height - size.h * newScale) / 2,
      };
      applyTransform();
      setScaleDisplay(newScale);
    },
    [applyTransform],
  );

  // Fit-to-screen: pick the largest scale that lets the SVG sit
  // inside the viewport with the toolbar / hint chrome breathing
  // room. Used both on initial open (so the diagram fills the screen
  // instead of opening at its tiny intrinsic size) and on the Reset
  // button — far more useful than "back to 100%".
  const fitToScreen = useCallback(() => {
    const c = containerRef.current;
    const size = measureNatural();
    if (!c || !size) return;
    const cr = c.getBoundingClientRect();
    // Vertical reserve = toolbar (~52px @ top-4) + hint (~36px @
    // bottom-4) + 24px breathing room. Horizontal = 32px each side.
    const padX = 32;
    const padTop = 76;
    const padBottom = 60;
    const availW = Math.max(100, cr.width - padX * 2);
    const availH = Math.max(100, cr.height - padTop - padBottom);
    const fit = Math.min(availW / size.w, availH / size.h);
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, fit));
    centerAtScale(next);
  }, [centerAtScale]);

  // Initial fit. measureNatural caches dimensions on first call
  // (when scale is still the seed value 1), so the same numbers feed
  // every later reset.
  useLayoutEffect(() => {
    fitToScreen();
  }, [fitToScreen, svg]);

  // Wheel-to-zoom. React's synthetic onWheel is passive, which means
  // calling e.preventDefault() inside it warns + the page still
  // scrolls. Attach the native listener with passive:false so we can
  // capture the wheel cleanly inside the modal.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { scale: s, tx: x, ty: y } = tRef.current;
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      // Multiplicative zoom so feel is consistent regardless of
      // current scale. Trackpad pinch reports tiny deltaY values;
      // mouse wheel reports ~100 per notch.
      const factor = Math.exp(-e.deltaY * ZOOM_SENSITIVITY);
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s * factor));
      if (next === s) return;
      const ratio = next / s;
      // Zoom anchored at the cursor: keep the SVG point under the
      // mouse fixed in screen space across the scale change.
      const ntx = mx - (mx - x) * ratio;
      const nty = my - (my - y) * ratio;
      tRef.current = { scale: next, tx: ntx, ty: nty };
      applyTransform();
      setScaleDisplay(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyTransform]);

  // Zoom around the centre of the viewport — used by the +/- keys and
  // the toolbar buttons where there's no cursor anchor.
  const zoomBy = useCallback(
    (factor: number) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const { scale: s, tx: x, ty: y } = tRef.current;
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s * factor));
      if (next === s) return;
      const ratio = next / s;
      tRef.current = {
        scale: next,
        tx: cx - (cx - x) * ratio,
        ty: cy - (cy - y) * ratio,
      };
      applyTransform();
      setScaleDisplay(next);
    },
    [applyTransform],
  );

  // Reset = fit-to-screen. The user opened fullscreen to see the
  // whole diagram; "back to where I started" is the fitted view, not
  // 100%. A second tap of `0` is a no-op (already fitted).
  const reset = useCallback(() => fitToScreen(), [fitToScreen]);

  // Keyboard shortcuts: 0 resets, +/- zoom, arrows pan. Esc is
  // handled by the parent Dialog primitive (built-in focus trap),
  // so we don't double-register it here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "0") {
        e.preventDefault();
        reset();
        return;
      }
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomBy(KEY_ZOOM_STEP);
        return;
      }
      if (e.key === "-") {
        e.preventDefault();
        zoomBy(1 / KEY_ZOOM_STEP);
        return;
      }
      let dx = 0;
      let dy = 0;
      if (e.key === "ArrowLeft") dx = KEY_PAN_STEP;
      else if (e.key === "ArrowRight") dx = -KEY_PAN_STEP;
      else if (e.key === "ArrowUp") dy = KEY_PAN_STEP;
      else if (e.key === "ArrowDown") dy = -KEY_PAN_STEP;
      else return;
      e.preventDefault();
      tRef.current = {
        ...tRef.current,
        tx: tRef.current.tx + dx,
        ty: tRef.current.ty + dy,
      };
      applyTransform();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reset, zoomBy, applyTransform]);

  // Pan tracking. We store the start in screen coords + the
  // transform-at-grab so each mousemove derives the new translation
  // from the original anchor — no drift across the gesture.
  const panRef = useRef<{ x: number; y: number; startTx: number; startTy: number } | null>(
    null,
  );
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    panRef.current = {
      x: e.clientX,
      y: e.clientY,
      startTx: tRef.current.tx,
      startTy: tRef.current.ty,
    };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!panRef.current) return;
    const dx = e.clientX - panRef.current.x;
    const dy = e.clientY - panRef.current.y;
    tRef.current = {
      ...tRef.current,
      tx: panRef.current.startTx + dx,
      ty: panRef.current.startTy + dy,
    };
    applyTransform();
  };
  const endPan = () => {
    panRef.current = null;
  };

  return (
    <>
      {/* Header bar — same shape as the SQL playground card's
          fullscreen header. Lives INSIDE the modal frame (not an
          overlay), so the canvas below has clean unobstructed pannable
          space. */}
      <div className="flex shrink-0 items-center gap-1 border-b bg-muted/30 px-3 py-1.5 text-xs">
        <span className="font-mono font-medium">mermaid</span>
        <span className="hidden font-mono text-muted-foreground sm:inline">
          · {Math.round(scaleDisplay * 100)}%
        </span>
        <div className="ml-auto flex items-center gap-1">
          <HeaderBtn
            label="Zoom out (-)"
            onClick={() => zoomBy(1 / KEY_ZOOM_STEP)}
            icon={<span className="text-sm leading-none">−</span>}
          />
          <HeaderBtn
            label="Zoom in (+)"
            onClick={() => zoomBy(KEY_ZOOM_STEP)}
            icon={<span className="text-sm leading-none">+</span>}
          />
          <HeaderBtn
            label="Fit to screen (0)"
            onClick={reset}
            icon={<RotateCcw className="size-3" />}
          />
          <HeaderBtn
            label={view === "svg" ? "Show source" : "Show diagram"}
            onClick={() =>
              setView((v) => (v === "svg" ? "raw" : "svg"))
            }
            icon={<Code className="size-3" />}
            active={view === "raw"}
          />
          <HeaderBtn
            label={copied ? "Copied!" : "Copy source"}
            onClick={onCopy}
            icon={
              copied ? (
                <Check className="size-3 text-emerald-500" />
              ) : (
                <Copy className="size-3" />
              )
            }
          />
          <HeaderBtn
            label="Close (Esc)"
            onClick={onClose}
            icon={<X className="size-3" />}
          />
        </div>
      </div>

      {/* Canvas — fills the remaining space. White surface keeps
          mermaid's light-theme default readable regardless of the
          app's theme; the dotted grid gives a "moving on paper" cue
          while panning. */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-white">
        {view === "svg" ? (
          <>
            <div
              ref={containerRef}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={endPan}
              onMouseLeave={endPan}
              className="absolute inset-0 overflow-hidden select-none cursor-grab active:cursor-grabbing"
              style={{
                touchAction: "none",
                backgroundImage:
                  "radial-gradient(circle, rgba(0,0,0,0.07) 1px, transparent 1px)",
                backgroundSize: "22px 22px",
              }}
            >
              {/* Transform driven by tRef + applyTransform — NO inline
                  style here, otherwise React re-renders would clobber
                  our ref-driven DOM updates on the next paint. */}
              <div
                ref={innerRef}
                style={{ transformOrigin: "0 0", width: "fit-content" }}
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </div>
            <div className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-white/95 px-2.5 py-1 text-[10.5px] text-zinc-600 shadow-sm">
              Wheel = zoom · Drag/Arrows = pan · +/- = step · 0 = fit ·
              Esc = close
            </div>
          </>
        ) : (
          <div className="absolute inset-0 overflow-auto p-6">
            <pre className="rounded-md border bg-zinc-50 p-4 font-mono text-xs leading-relaxed text-zinc-900">
              {source}
            </pre>
          </div>
        )}
      </div>
    </>
  );
}

// Header button — matches the small chrome buttons inside the SQL
// playground card so the two modals feel like they belong together.
function HeaderBtn({
  label,
  onClick,
  icon,
  active,
}: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-6 w-6 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
        active && "bg-muted text-foreground",
      )}
    >
      {icon}
    </button>
  );
}
