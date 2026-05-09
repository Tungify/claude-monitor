import type { Phase } from "@/lib/plan-types";

// DagLayout positions each phase at (x, y) on a 2D grid keyed off its
// dependency depth. Pure function — no React, no DOM. Fed into DagView
// which renders SVG edges + absolute-positioned phase cards.
//
// Algorithm:
//   1. depth(p) = 0 if p has no deps; otherwise 1 + max(depth of deps).
//      Cycles collapse to depth 0 (we still render the cycle members,
//      but `hasCycle` flips so the UI can warn).
//   2. Group phases by depth. Within a depth column, preserve the
//      caller's array order so the layout is stable across renders.
//   3. Place each node at (pad + depth*cellW, pad + indexInColumn*cellH).
//
// Coordinates are returned in raw pixels — DagView wraps the canvas in
// an overflow-auto container so wide DAGs simply scroll. We don't try
// to compress / minimize crossings; for the scale we expect (5-15
// phases per plan) the depth-based layering is readable enough and
// avoids a heavy graph layout dep.

export interface DagNode {
  slug: string;
  depth: number;
  x: number;
  y: number;
}

export interface DagEdge {
  from: string;
  to: string;
}

export interface DagLayout {
  nodes: DagNode[];
  edges: DagEdge[];
  width: number;
  height: number;
  cellW: number;
  cellH: number;
  // True if at least one cycle was detected. The layout is still
  // usable (cycle members are pinned at depth 0); the UI can decide
  // whether to surface a warning.
  hasCycle: boolean;
}

export interface DagLayoutOptions {
  cellW?: number;
  cellH?: number;
  pad?: number;
}

export function computeDagLayout(
  phases: readonly Phase[],
  opts: DagLayoutOptions = {},
): DagLayout {
  const cellW = opts.cellW ?? 240;
  const cellH = opts.cellH ?? 130;
  const pad = opts.pad ?? 24;

  const bySlug = new Map(phases.map((p) => [p.slug, p]));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  let hasCycle = false;

  function depthOf(slug: string): number {
    const cached = depths.get(slug);
    if (cached !== undefined) return cached;
    if (visiting.has(slug)) {
      // back-edge — treat the cycle member as depth 0 and flag.
      hasCycle = true;
      return 0;
    }
    const phase = bySlug.get(slug);
    if (!phase) return 0;
    const deps = (phase.depends_on ?? []).filter((d) => bySlug.has(d));
    if (deps.length === 0) {
      depths.set(slug, 0);
      return 0;
    }
    visiting.add(slug);
    let max = -1;
    for (const dep of deps) {
      const d = depthOf(dep);
      if (d > max) max = d;
    }
    visiting.delete(slug);
    const value = max + 1;
    depths.set(slug, value);
    return value;
  }

  for (const p of phases) depthOf(p.slug);

  // Bucket by depth; preserve input order within each bucket so the
  // layout is deterministic across re-renders.
  const byDepth = new Map<number, string[]>();
  for (const p of phases) {
    const d = depths.get(p.slug) ?? 0;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(p.slug);
  }

  const maxDepth = Math.max(0, ...Array.from(depths.values()));
  let maxColHeight = 0;
  const nodes: DagNode[] = [];
  for (let d = 0; d <= maxDepth; d++) {
    const slugs = byDepth.get(d) ?? [];
    if (slugs.length > maxColHeight) maxColHeight = slugs.length;
    slugs.forEach((slug, i) => {
      nodes.push({
        slug,
        depth: d,
        x: pad + d * cellW,
        y: pad + i * cellH,
      });
    });
  }

  // Edges only point at known phases (defensive — submit_plan validates
  // this server-side, but if the plan was hand-edited or a future
  // schema change broke the invariant, drop dangling edges).
  const edges: DagEdge[] = [];
  for (const p of phases) {
    for (const dep of p.depends_on ?? []) {
      if (bySlug.has(dep)) {
        edges.push({ from: dep, to: p.slug });
      }
    }
  }

  const width = pad * 2 + Math.max(1, maxDepth + 1) * cellW;
  const height = pad * 2 + Math.max(1, maxColHeight) * cellH;

  return { nodes, edges, width, height, cellW, cellH, hasCycle };
}
