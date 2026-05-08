import "server-only";

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { PlanRecord } from "@/lib/plan-types";

// Mirror Claude CLI's project-storage convention: each absolute cwd path is
// encoded by replacing every '/' with '-', producing a leading-dash slug
// (e.g. /Users/x/Repo → -Users-x-Repo). Verified against
// ~/.claude/projects/ on 2026-05-08.
export function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

export function plansDir(cwd: string): string {
  return path.join(homedir(), ".claude", "projects", encodeCwd(cwd), "plans");
}

export function planPath(cwd: string, planId: string): string {
  return path.join(plansDir(cwd), `${planId}.json`);
}

export async function writePlan(plan: PlanRecord): Promise<void> {
  const dir = plansDir(plan.cwd);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${plan.id}.json`);
  // Write to a temp file then rename so a concurrent reader never sees a
  // half-written JSON document.
  const tmp = `${file}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(plan, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export async function readPlan(
  cwd: string,
  planId: string,
): Promise<PlanRecord> {
  const file = planPath(cwd, planId);
  const buf = await fs.readFile(file, "utf8");
  return JSON.parse(buf) as PlanRecord;
}

export async function updatePlan(
  cwd: string,
  planId: string,
  mutate: (p: PlanRecord) => void,
): Promise<PlanRecord> {
  const plan = await readPlan(cwd, planId);
  mutate(plan);
  await writePlan(plan);
  return plan;
}
