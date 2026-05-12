"use client";

import { useCallback, useEffect, useState } from "react";

export interface DiffFileStat {
  path: string;
  additions: number;
  deletions: number;
  status: string | null;
}

export interface DiffInfo {
  totals: { additions: number; deletions: number };
  files: DiffFileStat[];
  // True while the first fetch is in flight.
  loading: boolean;
  // refresh re-runs the diff fetch. Useful to trigger when the user
  // opens the popover — they often check right after the agent
  // finishes a tool batch, and our 30s timer might be a few seconds
  // out of date.
  refresh: () => void;
}

const EMPTY: DiffInfo = {
  totals: { additions: 0, deletions: 0 },
  files: [],
  loading: false,
  refresh: () => {},
};

// useGitDiff returns the branch-vs-base + working-tree stats for the
// composer's BranchChip. Same refresh rhythm as useGitBranch so the
// two stay in lockstep: initial fetch, on window focus, and a 30s
// timer to catch out-of-band commits that the chat session didn't
// drive (manual `git commit` in the user's terminal, etc.).
//
// Returns EMPTY directly when cwd is null so the hook is safe to
// always call. The fetch path treats non-OK responses as "no diff",
// mirroring useGitBranch's "no chip" stance — better than blocking
// the chip on a transient git failure.
export function useGitDiff(cwd: string | null | undefined): DiffInfo {
  const [info, setInfo] = useState<Omit<DiffInfo, "refresh">>({
    totals: { additions: 0, deletions: 0 },
    files: [],
    loading: true,
  });
  // bump triggers a manual refetch when refresh() is called. We
  // deliberately key the effect on this counter rather than calling
  // fetchOnce directly so the in-flight abort + cancellation flag
  // logic stays in one place.
  const [bump, setBump] = useState(0);
  const refresh = useCallback(() => setBump((n) => n + 1), []);

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    const ctrl = new AbortController();

    const fetchOnce = async () => {
      try {
        const res = await fetch(
          `/api/fs/diff?path=${encodeURIComponent(cwd)}`,
          { signal: ctrl.signal },
        );
        if (!res.ok) {
          if (!cancelled) {
            setInfo({
              totals: { additions: 0, deletions: 0 },
              files: [],
              loading: false,
            });
          }
          return;
        }
        const data = (await res.json()) as {
          ok: boolean;
          totals: { additions: number; deletions: number };
          files: DiffFileStat[];
        };
        if (!cancelled) {
          setInfo({
            totals: data.totals ?? { additions: 0, deletions: 0 },
            files: data.files ?? [],
            loading: false,
          });
        }
      } catch {
        if (!cancelled) {
          setInfo({
            totals: { additions: 0, deletions: 0 },
            files: [],
            loading: false,
          });
        }
      }
    };

    void fetchOnce();
    const onFocus = () => void fetchOnce();
    window.addEventListener("focus", onFocus);
    const id = setInterval(() => void fetchOnce(), 30_000);

    return () => {
      cancelled = true;
      ctrl.abort();
      window.removeEventListener("focus", onFocus);
      clearInterval(id);
    };
  }, [cwd, bump]);

  if (!cwd) return EMPTY;
  return { ...info, refresh };
}
