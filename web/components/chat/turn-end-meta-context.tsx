"use client";

import { createContext, useContext } from "react";
import type { ReactNode } from "react";

// TurnEndMetaContext threads "this assistant message was the last in
// its turn" metadata to AssistantBubble so the meta footer
// ("3m 43s · ↑ 17.5k tokens · ↓ 1.2k · $0.0042") can render directly
// underneath the response content. Doing it via context — instead of
// rendering a separate ResultBubble divider — keeps the meta visually
// glued to the message that completed; without this, the streaming
// footer disappears at end-of-turn and a new bubble in a different
// place takes over, which reads as "the time went away".

export interface TurnEndMeta {
  durationMs: number;
  // Sum across the whole turn — input_tokens + cache_read + cache_create.
  // That's the "context size pumped into Claude" reading the CLI shows
  // as `↑`. Optional because some providers (OpenRouter shims, mocks)
  // ship a result with no usage payload.
  inputTokens?: number;
  outputTokens?: number;
  isError?: boolean;
  // Only set when isError is true; matches result.subtype shape.
  errorLabel?: string;
}

const Ctx = createContext<Map<string, TurnEndMeta> | null>(null);

export function TurnEndMetaProvider({
  byAssistantUuid,
  children,
}: {
  byAssistantUuid: Map<string, TurnEndMeta>;
  children: ReactNode;
}) {
  return <Ctx.Provider value={byAssistantUuid}>{children}</Ctx.Provider>;
}

// useTurnEndMeta returns the per-turn finish line for an assistant
// uuid, or null when the message isn't the last in its turn (or no
// provider is on the tree). AssistantBubble calls this to decide
// whether to append the meta footer.
export function useTurnEndMeta(
  assistantUuid: string | undefined,
): TurnEndMeta | null {
  const ctx = useContext(Ctx);
  if (!ctx || !assistantUuid) return null;
  return ctx.get(assistantUuid) ?? null;
}
