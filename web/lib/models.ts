// Static model registry. The Agent SDK accepts an arbitrary `model`
// string (it just forwards to the binary), so we list the ones the user's
// claude-monitor accounts can call. `[1m]` is the SDK's hint for the 1M
// context window variant — same model, different context cap.
//
// supportedEffortLevels comes from the SDK's docs:
//   xhigh — Opus 4.7 only
//   max   — Opus 4.6 / 4.7 only
import type { Effort } from "./chat-types";

export interface ModelInfo {
  id: string;
  label: string;
  badge?: string;
  contextWindow: number;
  supportedEffortLevels: Effort[];
}

export const MODELS: ModelInfo[] = [
  {
    id: "claude-opus-4-7",
    label: "Opus 4.7",
    contextWindow: 200_000,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "claude-opus-4-7[1m]",
    label: "Opus 4.7",
    badge: "1M",
    contextWindow: 1_000_000,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    contextWindow: 200_000,
    supportedEffortLevels: ["low", "medium", "high"],
  },
  {
    id: "claude-sonnet-4-6[1m]",
    label: "Sonnet 4.6",
    badge: "1M",
    contextWindow: 1_000_000,
    supportedEffortLevels: ["low", "medium", "high"],
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    contextWindow: 200_000,
    supportedEffortLevels: ["low", "medium", "high"],
  },
  {
    id: "claude-opus-4-6",
    label: "Opus 4.6",
    badge: "Legacy",
    contextWindow: 200_000,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
];

export const DEFAULT_MODEL_ID = "claude-opus-4-7[1m]";
export const DEFAULT_EFFORT: Effort = "high";

// CODEX_MODELS is the static fallback catalog when we can't read the
// account's live `/models` cache. Current slugs (2026-05) lifted from
// the codex CLI's models_cache.json — older `gpt-5-codex` / `gpt-5`
// slugs were retired server-side, so the ChatGPT-subscription endpoint
// now rejects them with 400. Account-specific lists arrive via
// /api/codex (reads ~/.codex*/models_cache.json) and override this.
//
// Effort levels: codex respects OpenAI Responses API `reasoning.effort`
// (low/medium/high/xhigh) per the cache; xhigh is gated on certain
// models, but we let the picker offer it and trust the server to
// clamp.
export interface CodexModelInfo {
  id: string;
  label: string;
  badge?: string;
  description?: string;
}

export const CODEX_MODELS: CodexModelInfo[] = [
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    description: "Flagship coding + reasoning",
  },
  {
    id: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    description: "Coding-tuned variant",
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    description: "General-purpose",
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    badge: "fast",
    description: "Lower-latency",
  },
  {
    id: "gpt-5.2",
    label: "GPT-5.2",
    badge: "legacy",
    description: "Prior generation",
  },
];

export const DEFAULT_CODEX_MODEL_ID = "gpt-5.5";

export function modelById(id?: string): ModelInfo | undefined {
  if (!id) return undefined;
  return MODELS.find((m) => m.id === id);
}

export function codexModelById(id?: string): CodexModelInfo | undefined {
  if (!id) return undefined;
  return CODEX_MODELS.find((m) => m.id === id);
}

export const EFFORT_LABELS: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};
