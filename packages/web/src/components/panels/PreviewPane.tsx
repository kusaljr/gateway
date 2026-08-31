import { useEffect, useState } from "react";
import { ExternalLink, Globe, RefreshCw } from "lucide-react";
import { fetchPreviewPorts, type PreviewPort } from "@/lib/api";

function normalize(u: string): string {
  const t = u.trim();
  if (!t) return t;
  if (!/^https?:\/\//i.test(t)) return `http://${t}`;
  return t;
}

export function PreviewPane({ id }: { id: string }) {
  const [url, setUrl] = useState("");
  const [draft, setDraft] = useState("");
  const [ports, setPorts] = useState<PreviewPort[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    fetchPreviewPorts().then((p) => {
      setPorts(p);
      const open = p.find((x) => x.open);
      if (open) {
        setUrl((cur) => cur || `http://127.0.0.1:${open.port}`);
        setDraft((cur) => cur || `http://127.0.0.1:${open.port}`);
      }
    });
  }, []);

  const go = (u: string) => {
    setUrl(u);
    setDraft(u);
    setReloadKey((k) => k + 1);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <Globe className="size-3.5 shrink-0 text-muted-foreground" />
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            go(normalize(draft));
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="http://localhost:3000"
            className="w-full rounded-control bg-muted px-2 py-1 font-mono text-[11px] outline-none"
          />
        </form>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={!url}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          aria-label="Reload preview"
        >
          <RefreshCw className="size-3.5" />
        </button>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Open in new tab"
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
      {ports.some((p) => p.open) && (
        <div className="flex shrink-0 flex-wrap gap-1 border-b border-border px-2 py-1">
          {ports
            .filter((p) => p.open)
            .map((p) => (
              <button
                key={p.port}
                onClick={() => go(`http://127.0.0.1:${p.port}`)}
                className="rounded-control bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                :{p.port}
              </button>
            ))}
        </div>
      )}
      <div className="min-h-0 flex-1 bg-background">
        {url ? (
          <iframe key={reloadKey} src={url} title={`preview-${id}`} className="h-full w-full border-0" />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-muted-foreground">
            No dev server detected on common ports. Enter a URL above (e.g. http://localhost:3000).
          </div>
        )}
      </div>
    </div>
  );
}
