import { z, type ZodRawShape } from "zod";
import type { ClickUpClient } from "./clickup.js";

export interface ToolCfg {
  description: string;
  input: ZodRawShape;
  // write tools are hidden when CLICKUP_READ_ONLY is set.
  write?: boolean;
  destructive?: boolean;
}

// Handlers return either a pre-rendered string (tables, trees, acks)
// or a value that gets pruned + minified to JSON.
export type Handler = (args: any) => Promise<unknown>;
export type Reg = (name: string, cfg: ToolCfg, fn: Handler) => void;
export type Module = (reg: Reg, c: ClickUpClient) => void;

// CLICKUP_READ_ONLY=1 hides every write tool (claude-monitor sets it
// unless the integration opts into writes).
export const READ_ONLY = /^(1|true|yes)$/i.test(process.env.CLICKUP_READ_ONLY ?? "");

// Shared arg shapes. Descriptions stay short: every word here is paid
// for on every session that lists the tools.
export const ws = z.string().optional();
export const taskId = z.string().describe("Task id or custom id (DEV-12)");
export const date = z.string().describe("YYYY-MM-DD or YYYY-MM-DD HH:MM");
export const full = z.boolean().optional().describe("Don't truncate long text");
