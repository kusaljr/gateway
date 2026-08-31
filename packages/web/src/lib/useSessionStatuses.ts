import { useEffect, useState } from "react";
import { fetchSessionStatuses, type SessionRunState } from "@/lib/api";
import { eventSessionId, subscribeConnection, subscribeEvents } from "@/lib/events";

/**
 * Which sessions opencode is currently working on, keyed by session id. Backed
 * by `GET /session/status` for the initial snapshot and kept live off the event
 * bus, so a running turn shows on its own thread and nowhere else.
 */
export function useSessionStatuses(): { statuses: Record<string, SessionRunState>; connected: boolean; ready: boolean } {
  const [statuses, setStatuses] = useState<Record<string, SessionRunState>>({});
  const [connected, setConnected] = useState(false);
  // A snapshot has landed at least once. This is what makes the map's SILENCE
  // meaningful: /session/status only lists opencode turns that are actually
  // running, so "no entry" means idle — but only once we have actually asked.
  // Before that, no entry means nothing at all.
  const [ready, setReady] = useState(false);

  useEffect(() => subscribeConnection(setConnected), []);

  // snapshot on mount and on every (re)connect — covers turns started elsewhere
  useEffect(() => {
    if (!connected) return;
    let alive = true;
    fetchSessionStatuses().then((next) => {
      if (!alive) return;
      setStatuses(next);
      setReady(true);
    });
    return () => { alive = false; };
  }, [connected]);

  useEffect(() => {
    let alive = true;
    fetchSessionStatuses().then((next) => {
      if (!alive) return;
      setStatuses(next);
      setReady(true);
    });
    return () => { alive = false; };
  }, []);

  useEffect(
    () =>
      subscribeEvents((event) => {
        const sid = eventSessionId(event);
        if (!sid) return;
        if (event.type === "session.status") {
          const status = event.properties["status"] as { type?: string } | string | undefined;
          const label = typeof status === "string" ? status : status?.type;
          if (label === "busy" || label === "retry" || label === "idle") {
            setStatuses((prev) => (prev[sid] === label ? prev : { ...prev, [sid]: label }));
          }
          return;
        }
        if (event.type === "session.idle" || event.type === "session.error") {
          setStatuses((prev) => (prev[sid] === "idle" ? prev : { ...prev, [sid]: "idle" }));
          return;
        }
        if (event.type === "session.deleted") {
          setStatuses((prev) => {
            if (!(sid in prev)) return prev;
            const next = { ...prev };
            delete next[sid];
            return next;
          });
        }
      }),
    [],
  );

  return { statuses, connected, ready };
}
