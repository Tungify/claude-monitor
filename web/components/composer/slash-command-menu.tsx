"use client";

import { useEffect, useRef } from "react";
import type { SlashCommand } from "@/lib/slash-commands";
import { cn } from "@/lib/utils";

interface Props {
  commands: SlashCommand[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onSelect: (command: SlashCommand) => void;
  // Lowercased substring the user typed after "/" — used to bold the
  // matching prefix on each row so it's obvious why a command is in the
  // list. Empty when the menu is showing the full registry.
  query: string;
}

// SlashCommandMenu is the autocomplete list rendered above the composer
// textarea while the user is typing a slash command. Keyboard navigation
// (Up/Down/Enter/Esc) lives in the parent so it can be coordinated with
// the textarea — this component is purely presentational.
export function SlashCommandMenu({
  commands,
  selectedIndex,
  onHover,
  onSelect,
  query,
}: Props) {
  const listRef = useRef<HTMLUListElement>(null);

  // Keep the highlighted row in view while the user arrow-keys through a
  // long list. We avoid scrollIntoView's smooth behavior here — the menu
  // is small enough that instant scrolling feels snappier.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    if (!item) return;
    const itemTop = item.offsetTop;
    const itemBottom = itemTop + item.offsetHeight;
    if (itemTop < list.scrollTop) {
      list.scrollTop = itemTop;
    } else if (itemBottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = itemBottom - list.clientHeight;
    }
  }, [selectedIndex]);

  if (commands.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 z-20 mb-2 px-2">
      <div className="overflow-hidden rounded-lg border bg-popover text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10">
        <div className="border-b px-3 py-1.5 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          Slash commands
        </div>
        <ul ref={listRef} className="max-h-64 overflow-y-auto py-1">
          {commands.map((cmd, i) => {
            const active = i === selectedIndex;
            return (
              <li key={cmd.name}>
                <button
                  type="button"
                  onMouseEnter={() => onHover(i)}
                  onMouseDown={(e) => {
                    // Mouse down (not click) so the textarea doesn't lose
                    // focus before the selection is committed — mousedown
                    // fires before the blur that a click would trigger.
                    e.preventDefault();
                    onSelect(cmd);
                  }}
                  className={cn(
                    "flex w-full items-baseline gap-3 px-3 py-1.5 text-left transition-colors",
                    active ? "bg-muted" : "hover:bg-muted/60",
                  )}
                >
                  <span className="font-mono text-xs">
                    /<MatchHighlight text={cmd.name} query={query} />
                    {cmd.argHint && (
                      <span className="ml-1 text-muted-foreground">
                        {cmd.argHint}
                      </span>
                    )}
                  </span>
                  <span className="ml-auto truncate text-xs text-muted-foreground">
                    {cmd.description}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="border-t px-3 py-1 text-[10px] text-muted-foreground/70">
          ↑↓ navigate · Enter run · Tab complete · Esc close
        </div>
      </div>
    </div>
  );
}

// MatchHighlight bolds the leading characters of `text` that match the
// user's query — same affordance the CLI uses when filtering /commands.
// Case-insensitive; falls back to plain text when query is empty or
// doesn't actually prefix the name (alias-only matches stay un-bolded
// rather than guessing which alias matched).
function MatchHighlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  if (!lower.startsWith(query)) return <>{text}</>;
  const head = text.slice(0, query.length);
  const tail = text.slice(query.length);
  return (
    <>
      <span className="font-semibold text-foreground">{head}</span>
      {tail}
    </>
  );
}
