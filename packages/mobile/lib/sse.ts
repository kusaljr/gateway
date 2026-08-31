// React Native has no EventSource and its fetch() doesn't expose an
// incrementally-readable response body, so a real SSE client here means the
// classic RN workaround: XMLHttpRequest's onprogress fires with the
// cumulative responseText so far, which we diff against what we've already
// consumed and parse as standard "data: <json>\n\n" frames.
export type SSEEvent = { type: string; properties: Record<string, unknown> };

export function openEventStream(
  url: string,
  headers: Record<string, string>,
  onEvent: (e: SSEEvent) => void,
  onOpen?: () => void,
  onDone?: () => void
): () => void {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url, true);
  Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));

  let consumed = 0;
  let buffer = "";
  let opened = false;

  const parseAndDispatch = (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLines = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""));
      if (dataLines.length === 0) continue;
      const raw = dataLines.join("\n");
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.type === "string") {
          onEvent({ type: parsed.type, properties: parsed.properties || {} });
        }
      } catch {
        // partial/non-JSON frame — ignore, stream continues
      }
    }
  };

  xhr.onreadystatechange = () => {
    if (!opened && (xhr.readyState === 2 || xhr.readyState === 3)) {
      opened = true;
      onOpen?.();
    }
  };
  // @ts-ignore RN's XHR supports onprogress though it's not in the lib.dom types used here
  xhr.onprogress = () => {
    const text: string = xhr.responseText || "";
    if (text.length > consumed) {
      parseAndDispatch(text.slice(consumed));
      consumed = text.length;
    }
  };
  xhr.onloadend = () => onDone?.();
  xhr.onerror = () => onDone?.();

  xhr.send();
  return () => xhr.abort();
}
