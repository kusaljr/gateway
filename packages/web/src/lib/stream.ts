import type { OCMessage, OCPart } from "@/lib/api";

/**
 * Incremental application of opencode's SSE events to the message list.
 *
 * The old chat refetched every message every 600ms; opencode already streams
 * `message.updated` / `message.part.updated` / `message.part.delta`, so a turn
 * only needs the changed part patched in.
 */
type Props = Record<string, unknown>;

type MessageInfo = OCMessage["info"] & { id?: string };

export function applyStreamEvent(list: OCMessage[], type: string, props: Props): OCMessage[] {
  switch (type) {
    case "message.updated":
      return upsertMessage(list, props["info"] as MessageInfo | undefined);
    case "message.removed":
      return removeMessage(list, props["messageID"] as string | undefined);
    case "message.part.updated":
      return upsertPart(list, props["part"] as (OCPart & { messageID?: string }) | undefined);
    case "message.part.removed":
      return removePart(list, props["messageID"] as string | undefined, props["partID"] as string | undefined);
    case "message.part.delta":
      return applyPartDelta(
        list,
        props["messageID"] as string | undefined,
        props["partID"] as string | undefined,
        props["field"] as string | undefined,
        props["delta"] as string | undefined,
      );
    default:
      return list;
  }
}

function upsertMessage(list: OCMessage[], info?: MessageInfo): OCMessage[] {
  if (!info?.id) return list;
  const idx = list.findIndex((m) => m.info.id === info.id);
  if (idx === -1) {
    // a brand new turn: opencode sends the info before any part
    return [...list, { info, parts: [] }];
  }
  const next = list.slice();
  next[idx] = { ...next[idx]!, info: { ...next[idx]!.info, ...info } };
  return next;
}

function removeMessage(list: OCMessage[], messageID?: string): OCMessage[] {
  if (!messageID) return list;
  return list.filter((m) => m.info.id !== messageID);
}

function upsertPart(list: OCMessage[], part?: OCPart & { messageID?: string }): OCMessage[] {
  if (!part?.messageID) return list;
  const idx = indexOfMessage(list, part.messageID);
  if (idx === -1) {
    // part before info (possible on reconnect): stub the message so nothing is dropped
    return [...list, { info: { role: "assistant", id: part.messageID }, parts: [part] }];
  }
  const next = list.slice();
  const message = next[idx]!;
  const parts = message.parts.slice();
  const partIdx = parts.findIndex((p) => (part.id ? p.id === part.id : p.callID && p.callID === part.callID));
  if (partIdx === -1) parts.push(part);
  else parts[partIdx] = { ...parts[partIdx]!, ...part };
  next[idx] = { ...message, parts };
  return next;
}

function removePart(list: OCMessage[], messageID?: string, partID?: string): OCMessage[] {
  if (!messageID || !partID) return list;
  const idx = indexOfMessage(list, messageID);
  if (idx === -1) return list;
  const next = list.slice();
  next[idx] = { ...next[idx]!, parts: next[idx]!.parts.filter((p) => p.id !== partID) };
  return next;
}

/** Token streaming: append `delta` to the named field of one part. */
function applyPartDelta(
  list: OCMessage[],
  messageID?: string,
  partID?: string,
  field?: string,
  delta?: string,
): OCMessage[] {
  if (!messageID || !partID || !field || !delta) return list;
  const idx = indexOfMessage(list, messageID);
  if (idx === -1) return list;
  const message = list[idx]!;
  const partIdx = message.parts.findIndex((p) => p.id === partID);
  if (partIdx === -1) return list;

  const part = message.parts[partIdx]!;
  const patched: OCPart = { ...part };
  if (field === "text" || field === "reasoning") {
    patched.text = `${part.text ?? ""}${delta}`;
  } else if (field === "output") {
    patched.state = { ...part.state, output: `${part.state?.output ?? ""}${delta}` };
  } else {
    return list;
  }

  const next = list.slice();
  const parts = message.parts.slice();
  parts[partIdx] = patched;
  next[idx] = { ...message, parts };
  return next;
}

function indexOfMessage(list: OCMessage[], messageID: string): number {
  return list.findIndex((m) => m.info.id === messageID);
}
