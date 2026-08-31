import { eventStreamUrl } from "@/lib/api";

/**
 * One EventSource for the whole app. Every view (chat timeline, sidebar run
 * states) subscribes to the same opencode event bus instead of opening its own
 * stream, and events are dispatched with their session id so consumers can
 * isolate the thread they care about.
 */
export type OCEvent = { type: string; properties: Record<string, unknown> };
type Handler = (event: OCEvent) => void;

const handlers = new Set<Handler>();
const connectionHandlers = new Set<(connected: boolean) => void>();
let source: EventSource | null = null;
let connected = false;

function setConnected(next: boolean) {
  if (connected === next) return;
  connected = next;
  for (const cb of connectionHandlers) cb(next);
}

function open() {
  if (source) return;
  try {
    source = new EventSource(eventStreamUrl());
  } catch {
    setConnected(false);
    return;
  }
  source.onopen = () => setConnected(true);
  source.onerror = () => setConnected(false); // EventSource retries on its own
  source.onmessage = (ev) => {
    let event: OCEvent;
    try {
      const parsed = JSON.parse(ev.data) as { type?: string; properties?: Record<string, unknown> };
      event = { type: parsed.type ?? "", properties: parsed.properties ?? {} };
    } catch {
      return;
    }
    for (const handler of handlers) handler(event);
  };
}

function closeIfIdle() {
  if (handlers.size > 0 || connectionHandlers.size > 0) return;
  source?.close();
  source = null;
  setConnected(false);
}

export function subscribeEvents(handler: Handler): () => void {
  handlers.add(handler);
  open();
  return () => {
    handlers.delete(handler);
    closeIfIdle();
  };
}

export function subscribeConnection(handler: (connected: boolean) => void): () => void {
  connectionHandlers.add(handler);
  handler(connected);
  open();
  return () => {
    connectionHandlers.delete(handler);
    closeIfIdle();
  };
}

/** sessionID carried by the event, when it belongs to one. */
export function eventSessionId(event: OCEvent): string | null {
  const props = event.properties;
  const direct = props["sessionID"];
  if (typeof direct === "string") return direct;
  const info = props["info"] as { id?: string; sessionID?: string } | undefined;
  if (info && typeof info.sessionID === "string") return info.sessionID;
  const part = props["part"] as { sessionID?: string } | undefined;
  if (part && typeof part.sessionID === "string") return part.sessionID;
  return null;
}
