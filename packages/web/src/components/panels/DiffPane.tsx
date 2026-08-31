import { useCallback, useEffect, useState } from "react";
import { GitBranch, RefreshCw } from "lucide-react";
import { fetchGitDiff, type GitDiffResult } from "@/lib/api";
import { cn } from "@/lib/utils";

type DiffFile = {
  path: string;
  isNew: boolean;
  isDeleted: boolean;
  additions: number;
  deletions: number;
  lines: string[];
};

function parseDiff(raw: string): DiffFile[] {
  if (!raw.trim()) return [];
  return raw
    .split(/^diff --git /m)
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const header = lines[0] ?? "";
      const m = header.match(/a\/?(.*?) b\/?(.*)$/);
      let path = (m ? m[2] : header).trim();
      let additions = 0;
      let deletions = 0;
      let isNew = false;
      let isDeleted = false;
      const body: string[] = [];
      for (const l of lines.slice(1)) {
        if (l.startsWith("+++ b/")) path = l.slice(6).trim();
        else if (l.startsWith("new file mode")) isNew = true;
        else if (l.startsWith("deleted file mode")) isDeleted = true;
        if (l.startsWith("index ") || l.startsWith("--- ") || l.startsWith("+++ ") || l.startsWith("old mode") || l.startsWith("new mode")) continue;
        if (l.startsWith("+") && !l.startsWith("+++")) additions++;
        else if (l.startsWith("-") && !l.startsWith("---")) deletions++;
        body.push(l);
      }
      return { path, isNew, isDeleted, additions, deletions, lines: body };
    })
    .filter((f) => f.path);
}

export function DiffPane({ cwd }: { cwd: string }) {
  const [result, setResult] = useState<GitDiffResult | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetchGitDiff(cwd)
      .then(setResult)
      .finally(() => setLoading(false));
  }, [cwd]);

  useEffect(() => load(), [load]);

  const files = result ? parseDiff([result.diff, result.untracked].filter(Boolean).join("\n")) : [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2.5 text-[11px]">
        <GitBranch className="size-3.5 text-muted-foreground" />
        <span className="font-medium text-foreground">{result?.branch || "—"}</span>
        <span className="truncate text-muted-foreground">{cwd || "no project selected"}</span>
        <button
          onClick={load}
          className="ms-auto shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Refresh diff"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {result && !result.isRepo && (
          <div className="p-6 text-center text-[13px] text-muted-foreground">Not a git repository.</div>
        )}
        {result?.isRepo && files.length === 0 && (
          <div className="p-6 text-center text-[13px] text-muted-foreground">No changes.</div>
        )}
        {files.map((f, fi) => (
          <div key={`${f.path}-${fi}`} className="mb-3 overflow-hidden rounded-[var(--radius)] border border-border">
            <div className="flex items-center gap-2 bg-muted px-2 py-1 font-mono text-[11px] text-foreground">
              <span className="truncate">{f.path}</span>
              {f.isNew && <span className="shrink-0 text-muted-foreground">new</span>}
              {f.isDeleted && <span className="shrink-0 text-muted-foreground">deleted</span>}
              <span className="ms-auto shrink-0 text-success-foreground">+{f.additions}</span>
              <span className="shrink-0 text-error-foreground">-{f.deletions}</span>
            </div>
            <div className="overflow-x-auto font-mono text-[11px] leading-[1.5]">
              {f.lines.map((l, i) => {
                if (l.startsWith("@@"))
                  return (
                    <div key={i} className="whitespace-pre bg-accent/40 px-2 text-muted-foreground">
                      {l}
                    </div>
                  );
                if (l.startsWith("+") && !l.startsWith("+++"))
                  return (
                    <div key={i} className="whitespace-pre bg-success/10 px-2 text-success-foreground">
                      {l}
                    </div>
                  );
                if (l.startsWith("-") && !l.startsWith("---"))
                  return (
                    <div key={i} className="whitespace-pre bg-error/10 px-2 text-error-foreground">
                      {l}
                    </div>
                  );
                return (
                  <div key={i} className="whitespace-pre px-2 text-foreground/80">
                    {l}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
