// Minimal ANSI SGR parser → React spans. Built for the script-runner
// popover so colorized npm/cargo/etc. output doesn't land as a
// monochrome wall of text. Not a full terminal emulator — we ignore
// cursor-movement and clear-line sequences (they'd require a screen
// buffer to make sense of, which would balloon the component well
// past its purpose). What's covered:
//
//   - SGR (CSI ... m): reset, bold, dim, italic, underline,
//     inverse, default fg/bg, basic 30–37 / 40–47, bright 90–97 /
//     100–107, 256-color 38;5;N / 48;5;N, truecolor 38;2;R;G;B /
//     48;2;R;G;B.
//   - Other CSI sequences (cursor moves, ED/EL, etc.) are swallowed
//     silently; they don't produce visible glyphs anyway.
//   - OSC / DCS / APC sequences are swallowed up to BEL or ST.
//
// The parser is incremental-friendly: an incomplete escape at the
// end of the buffer is emitted as literal text. On the next render
// (when more bytes have arrived) it gets re-parsed correctly. There
// can be a brief one-frame flicker for chunks that split mid-escape,
// which is acceptable for a non-critical output panel.

import { Fragment, type CSSProperties, type ReactNode } from "react";

interface Style {
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
  fg?: string;
  bg?: string;
}

// VS Code-ish palette — readable on both light + dark surfaces and
// matches what most CLIs assume. Light/dark theming is left to the
// host: these colors sit on top of the popover's muted background.
const BASIC: readonly string[] = [
  "#3b3b3b", // black
  "#cd3131", // red
  "#0dbc79", // green
  "#e5e510", // yellow
  "#2472c8", // blue
  "#bc3fbc", // magenta
  "#11a8cd", // cyan
  "#e5e5e5", // white
];

const BRIGHT: readonly string[] = [
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#ffffff",
];

// 256-color cube + grayscale ramp. The first 16 entries reuse the
// basic+bright palette so 38;5;0..15 stays consistent with 30..37 /
// 90..97. 16..231 is the 6×6×6 cube, 232..255 is the grayscale ramp.
function color256(n: number): string {
  if (n < 8) return BASIC[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const i = n - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    const ch = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${ch(r)},${ch(g)},${ch(b)})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v},${v},${v})`;
}

function applySgr(style: Style, params: number[]): Style {
  const next: Style = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    switch (p) {
      case 0: {
        // reset everything
        return {};
      }
      case 1:
        next.bold = true;
        break;
      case 2:
        next.dim = true;
        break;
      case 3:
        next.italic = true;
        break;
      case 4:
        next.underline = true;
        break;
      case 7:
        next.inverse = true;
        break;
      case 9:
        next.strike = true;
        break;
      case 22:
        next.bold = false;
        next.dim = false;
        break;
      case 23:
        next.italic = false;
        break;
      case 24:
        next.underline = false;
        break;
      case 27:
        next.inverse = false;
        break;
      case 29:
        next.strike = false;
        break;
      case 39:
        delete next.fg;
        break;
      case 49:
        delete next.bg;
        break;
      case 38:
      case 48: {
        const mode = params[i + 1];
        const target: "fg" | "bg" = p === 38 ? "fg" : "bg";
        if (mode === 5) {
          const n = params[i + 2];
          if (typeof n === "number") next[target] = color256(n);
          i += 2;
        } else if (mode === 2) {
          const r = params[i + 2];
          const g = params[i + 3];
          const b = params[i + 4];
          if (
            typeof r === "number" &&
            typeof g === "number" &&
            typeof b === "number"
          ) {
            next[target] = `rgb(${r},${g},${b})`;
          }
          i += 4;
        }
        break;
      }
      default: {
        if (p >= 30 && p <= 37) next.fg = BASIC[p - 30];
        else if (p >= 40 && p <= 47) next.bg = BASIC[p - 40];
        else if (p >= 90 && p <= 97) next.fg = BRIGHT[p - 90];
        else if (p >= 100 && p <= 107) next.bg = BRIGHT[p - 100];
        // anything else is a no-op (blink, hide, etc.)
      }
    }
  }
  return next;
}

function styleToCss(s: Style): CSSProperties | undefined {
  if (
    !s.bold &&
    !s.dim &&
    !s.italic &&
    !s.underline &&
    !s.inverse &&
    !s.strike &&
    !s.fg &&
    !s.bg
  ) {
    return undefined;
  }
  const fg = s.inverse ? s.bg : s.fg;
  const bg = s.inverse ? s.fg : s.bg;
  const css: CSSProperties = {};
  if (s.bold) css.fontWeight = 700;
  if (s.dim) css.opacity = 0.65;
  if (s.italic) css.fontStyle = "italic";
  // Combine underline + strike-through into a single
  // text-decoration so both can apply.
  const decos: string[] = [];
  if (s.underline) decos.push("underline");
  if (s.strike) decos.push("line-through");
  if (decos.length) css.textDecoration = decos.join(" ");
  if (fg) css.color = fg;
  if (bg) css.backgroundColor = bg;
  return css;
}

// Renders an arbitrary string with embedded ANSI escapes as a
// sequence of styled React nodes. Pure function — output is stable
// across renders for the same input, so the parent's React reconciler
// is happy.
export function renderAnsi(input: string): ReactNode {
  if (!input) return null;
  const out: ReactNode[] = [];
  let style: Style = {};
  let i = 0;
  let textStart = 0;
  let key = 0;

  const flushText = (end: number) => {
    if (end <= textStart) return;
    const text = input.slice(textStart, end);
    const css = styleToCss(style);
    if (css) {
      out.push(
        <span key={key++} style={css}>
          {text}
        </span>,
      );
    } else {
      out.push(<Fragment key={key++}>{text}</Fragment>);
    }
    textStart = end;
  };

  while (i < input.length) {
    const ch = input.charCodeAt(i);
    if (ch !== 0x1b) {
      i++;
      continue;
    }
    const escStart = i;
    flushText(escStart);
    const next = input.charCodeAt(i + 1);
    if (next === 0x5b /* [ */) {
      // CSI: ESC [ params final-byte. Final byte is in 0x40..0x7e.
      let j = i + 2;
      while (j < input.length) {
        const c = input.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) break;
        j++;
      }
      if (j >= input.length) {
        // Incomplete — leave the bytes as literal so the next render
        // (with more data) can re-parse properly.
        textStart = escStart;
        i = input.length;
        break;
      }
      const final = input.charCodeAt(j);
      if (final === 0x6d /* m */) {
        const paramStr = input.slice(i + 2, j);
        const params = paramStr === ""
          ? [0]
          : paramStr.split(";").map((s) => Number.parseInt(s, 10) || 0);
        style = applySgr(style, params);
      }
      // Non-SGR CSI (cursor movement, EL, ED, …) is dropped silently.
      i = j + 1;
      textStart = i;
      continue;
    }
    if (next === 0x5d /* ] */) {
      // OSC: ESC ] ... ( BEL | ESC \ )
      let j = i + 2;
      while (j < input.length) {
        const c = input.charCodeAt(j);
        if (c === 0x07) {
          j++;
          break;
        }
        if (c === 0x1b && input.charCodeAt(j + 1) === 0x5c) {
          j += 2;
          break;
        }
        j++;
      }
      if (j > input.length) {
        textStart = escStart;
        i = input.length;
        break;
      }
      i = j;
      textStart = i;
      continue;
    }
    if (
      next === 0x50 /* P */ ||
      next === 0x58 /* X */ ||
      next === 0x5e /* ^ */ ||
      next === 0x5f /* _ */
    ) {
      // DCS / SOS / PM / APC — runs until ESC \
      let j = i + 2;
      while (j < input.length - 1) {
        if (
          input.charCodeAt(j) === 0x1b &&
          input.charCodeAt(j + 1) === 0x5c
        ) {
          j += 2;
          break;
        }
        j++;
      }
      if (j >= input.length) {
        textStart = escStart;
        i = input.length;
        break;
      }
      i = j;
      textStart = i;
      continue;
    }
    // Other 2-byte sequences (ESC c reset, ESC = / ESC > keypad
    // mode, ESC ( charset select, etc.) — skip 2 bytes and continue.
    if (i + 1 >= input.length) {
      textStart = escStart;
      break;
    }
    i += 2;
    textStart = i;
  }
  flushText(input.length);

  return out;
}
