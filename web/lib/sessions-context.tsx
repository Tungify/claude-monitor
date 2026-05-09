"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import type { SessionStatus, SessionSummary } from "@/lib/chat-types";

interface SessionsContextValue {
  sessions: SessionSummary[];
  loaded: boolean;
  refresh: () => void;
  // Set of session ids whose latest task just finished — i.e. status
  // transitioned thinking|awaiting_permission|starting → idle while
  // the user wasn't viewing that chat. Drives the green "done" check
  // in the sidebar; cleared by markVisited when the user opens the
  // chat. Empty Set when nothing is unread.
  unseenDone: Set<string>;
  // Imperative hook for the sidebar Link onClick — clears the green
  // "done" mark for that session id immediately, without waiting on a
  // pathname-driven effect (which the lint rule flags as a cascading
  // setState).
  markVisited: (id: string) => void;
}

const SessionsContext = createContext<SessionsContextValue | null>(null);

// SessionsProvider centralises the /api/chat polling so the sidebar's
// running-tasks panel and the full sessions list share one fetch instead
// of each opening their own. Refetches when the pathname changes (a new
// chat just landed) and when useChatSession dispatches the
// cm:session-subagents window event (subagent state moved).
export function SessionsProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [unseenDone, setUnseenDone] = useState<Set<string>>(new Set());
  // Coalesce rapid-fire fetches: every assistant turn during a subagent's
  // run flips the fingerprint, but we only need ~250ms granularity.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last-seen status per session, used to detect "just finished"
  // transitions on each poll. Lives on a ref so updates don't trigger
  // re-renders; only the Set above does.
  const prevStatusRef = useRef<Map<string, SessionStatus>>(new Map());

  // Pull the current chat id off /chat/<id> so we can suppress the
  // "done" mark on the chat the user is staring at — they don't need
  // to be told a task they're watching just finished. Mirror it onto
  // a ref so the fetchOnce callback (which has stable []-deps) can
  // read the latest value without rebinding.
  const activeChatId = pathname?.startsWith("/chat/")
    ? pathname.slice("/chat/".length).split("/")[0]
    : undefined;
  const activeChatIdRef = useRef<string | undefined>(undefined);
  // Sync via effect — assigning during render trips the
  // react-hooks/refs lint rule. The 1-tick lag between activeChatId
  // changing and the ref updating is fine: a new poll triggered by
  // the same pathname-effect below already runs after this commit.
  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  // fetchOnce diffs new vs prev statuses inside the callback (which is
  // not an effect body, so setState here is fine). Detecting "just
  // finished" transitions live in the response handler keeps the
  // unseen-done set in sync with the polling cadence without an extra
  // useEffect that the React Compiler / set-state-in-effect lint flags.
  const fetchOnce = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/chat", { signal });
      if (!res.ok) return;
      const data = (await res.json()) as { sessions: SessionSummary[] };
      const prev = prevStatusRef.current;
      const newlyDone: string[] = [];
      const seen = new Set<string>();
      const active = activeChatIdRef.current;
      for (const s of data.sessions) {
        seen.add(s.id);
        const before = prev.get(s.id);
        const settled =
          s.status === "idle" ||
          s.status === "errored" ||
          s.status === "closed";
        const wasWorking =
          before === "thinking" ||
          before === "awaiting_permission" ||
          before === "starting";
        if (wasWorking && settled && s.id !== active) {
          newlyDone.push(s.id);
        }
        prev.set(s.id, s.status);
      }
      // Drop ids no longer in the list (deleted sessions) so the ref
      // doesn't grow unbounded.
      for (const id of [...prev.keys()]) {
        if (!seen.has(id)) prev.delete(id);
      }
      setSessions(data.sessions);
      if (newlyDone.length > 0) {
        setUnseenDone((existing) => {
          const next = new Set(existing);
          for (const id of newlyDone) next.add(id);
          return next;
        });
      }
    } catch {
      // Aborted or transient. Next refresh recovers.
    }
  }, []);

  // markVisited drops the chat id from the unseen-done set. Called
  // from sidebar row click handlers — keeping it imperative avoids
  // the pathname-driven setState-in-effect that the lint rule flags.
  const markVisited = useCallback((id: string) => {
    setUnseenDone((existing) => {
      if (!existing.has(id)) return existing;
      const next = new Set(existing);
      next.delete(id);
      return next;
    });
  }, []);

  // Initial + route-change refresh.
  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;
    void (async () => {
      await fetchOnce(ctrl.signal);
      if (!cancelled) setLoaded(true);
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [pathname, fetchOnce]);

  // Subagent-update event from useChatSession. Debounced so a burst of
  // tool_use deltas doesn't slam the API.
  useEffect(() => {
    const onUpdate = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void fetchOnce();
      }, 250);
    };
    window.addEventListener("cm:session-subagents", onUpdate);
    return () => {
      window.removeEventListener("cm:session-subagents", onUpdate);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [fetchOnce]);

  // Also poll on a slow timer so a session whose status flipped from
  // thinking->idle while we were on a different chat shows up without
  // forcing the user to navigate. 5s is fast enough to feel responsive
  // and slow enough to not thrash the daemon.
  useEffect(() => {
    const id = setInterval(() => void fetchOnce(), 5000);
    return () => clearInterval(id);
  }, [fetchOnce]);

  const refresh = useCallback(() => void fetchOnce(), [fetchOnce]);

  return (
    <SessionsContext.Provider
      value={{ sessions, loaded, refresh, unseenDone, markVisited }}
    >
      {children}
    </SessionsContext.Provider>
  );
}

export function useSessions(): SessionsContextValue {
  const ctx = useContext(SessionsContext);
  if (!ctx) throw new Error("useSessions must be used within SessionsProvider");
  return ctx;
}

// stopSession asks the API to terminate a session. Returns true on
// success so the caller can update local state optimistically.
export async function stopSessionRemote(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/chat/${sessionId}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}
