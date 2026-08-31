import type { OCMessage, OCPart } from "./api";

// Mirrors packages/web/src/lib/stream.ts's applyStreamEvent exactly: upserts
// message info, upserts/deltas a part by id (falling back to callID for tool
// parts), removes on message.removed/part.removed. Returns a new array —
// callers setState with the result.
export function applyStreamEvent(messages: OCMessage[], type: string, properties: any): OCMessage[] {
  switch (type) {
    case "message.updated": {
      const info = properties?.info;
      const sid = info?.id;
      if (!sid) return messages;
      const idx = messages.findIndex((m) => m.info.id === sid);
      if (idx === -1) return [...messages, { info, parts: [] }];
      const next = messages.slice();
      next[idx] = { ...next[idx], info: { ...next[idx].info, ...info } };
      return next;
    }
    case "message.removed": {
      const sid = properties?.info?.id ?? properties?.messageID;
      return messages.filter((m) => m.info.id !== sid);
    }
    case "message.part.updated": {
      const part: OCPart = properties?.part;
      if (!part) return messages;
      return upsertPart(messages, part.messageID, part, (p) => (part.id ? p.id === part.id : part.callID ? p.callID === part.callID : false));
    }
    case "message.part.delta": {
      const part = properties?.part;
      const delta: string = properties?.delta ?? part?.delta ?? "";
      if (!part || !delta) return messages;
      return mutatePart(messages, part.messageID, part, (existing) => {
        if (part.type === "text" || part.type === "reasoning") {
          return { ...existing, text: (existing.text || "") + delta };
        }
        return { ...existing, state: { ...existing.state, output: (existing.state?.output || "") + delta } };
      });
    }
    case "message.part.removed": {
      const messageID = properties?.messageID;
      const partID = properties?.partID ?? properties?.part?.id;
      if (!messageID || !partID) return messages;
      return messages.map((m) => (m.info.id === messageID ? { ...m, parts: m.parts.filter((p) => p.id !== partID) } : m));
    }
    default:
      return messages;
  }
}

function upsertPart(messages: OCMessage[], messageID: string | undefined, part: OCPart, match: (p: OCPart) => boolean): OCMessage[] {
  if (!messageID) return messages;
  const idx = messages.findIndex((m) => m.info.id === messageID);
  if (idx === -1) return [...messages, { info: { role: "assistant", id: messageID }, parts: [part] }];
  const msg = messages[idx];
  const pIdx = msg.parts.findIndex(match);
  const nextParts = pIdx === -1 ? [...msg.parts, part] : msg.parts.map((p, i) => (i === pIdx ? { ...p, ...part } : p));
  const next = messages.slice();
  next[idx] = { ...msg, parts: nextParts };
  return next;
}

function mutatePart(messages: OCMessage[], messageID: string | undefined, part: OCPart, mutate: (existing: OCPart) => OCPart): OCMessage[] {
  if (!messageID) return messages;
  const idx = messages.findIndex((m) => m.info.id === messageID);
  if (idx === -1) return [...messages, { info: { role: "assistant", id: messageID }, parts: [mutate(part)] }];
  const msg = messages[idx];
  const match = (p: OCPart) => (part.id ? p.id === part.id : part.callID ? p.callID === part.callID : false);
  const pIdx = msg.parts.findIndex(match);
  const nextParts = pIdx === -1 ? [...msg.parts, mutate(part)] : msg.parts.map((p, i) => (i === pIdx ? mutate(p) : p));
  const next = messages.slice();
  next[idx] = { ...msg, parts: nextParts };
  return next;
}

// text/reasoning/tool are the only part types the timeline renders — matches
// ChatView.tsx's hasVisible check exactly (anything else is silently skipped).
export function hasVisibleParts(msg: OCMessage): boolean {
  return msg.parts.some((p) => (p.type === "text" && p.text?.trim()) || p.type === "reasoning" || p.type === "tool");
}
