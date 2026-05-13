"use client";

import { useEffect, useRef } from "react";
import type { SessionStatus } from "@/lib/chat-types";

export function useDesktopNotifications(status: SessionStatus, sessionTitle?: string) {
  const prevStatusRef = useRef<SessionStatus>(status);

  // Request permission proactively on first mount
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;

    const prev = prevStatusRef.current;
    prevStatusRef.current = status;

    // Fire when transitioning from an active state to idle
    if (status !== "idle") return;
    if (prev !== "thinking" && prev !== "awaiting_permission") return;

    if (Notification.permission !== "granted") return;

    new Notification("Claude đã trả lời xong", {
      body: sessionTitle ? `Session: ${sessionTitle}` : "Nhấn để xem.",
      icon: "/favicon.ico",
      tag: "claude-done",
    });
  }, [status, sessionTitle]);
}
