import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, CornerLeftUp, Folder, FolderOpen, Loader2, Search, Server } from "lucide-react";
import { cn } from "@/lib/utils";
import { ensureProject, fetchFsList, type Device, type FsEntry, type Project } from "@/lib/api";

/**
 * Command-palette project picker, modelled on t3code's add-project palette
 * (apps/web/src/components/CommandPalette.tsx + CommandPalette.logic.ts):
 * one input that doubles as a path field, "Directories" rows you descend with
 * Enter, and a keyboard-hint footer. Typing `/` or `~` switches to browsing.
 */
export function ProjectPicker({ open, onClose, onPicked, projects, device }: {
  open: boolean;
  onClose: () => void;
  onPicked: (project: Project) => void;
  projects: Project[];
  device: Device | null;
}) {
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [dirMissing, setDirMissing] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [creating, setCreating] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const browse = useMemo(() => parseBrowseQuery(query), [query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // list the directory the query points at; the trailing segment filters it
  useEffect(() => {
    if (!open || !browse.browsing) {
      setEntries([]);
      setDirMissing(false);
      return;
    }
    let alive = true;
    setLoading(true);
    fetchFsList(browse.dir)
      .then((r) => {
        if (!alive) return;
        setEntries(r.entries);
        setDirMissing(r.entries.length === 0 && !r.cwd);
      })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [open, browse.browsing, browse.dir]);

  const items = useMemo<PickerItem[]>(() => {
    if (!browse.browsing) {
      const needle = browse.filter.toLowerCase();
      const matched = projects.filter((p) => !needle || `${p.name} ${p.path}`.toLowerCase().includes(needle));
      const rows: PickerItem[] = matched.map((p) => ({ kind: "project", key: `p:${p.id}`, label: p.name || p.path, hint: p.path, project: p }));
      rows.push({ kind: "browse", key: "browse", label: "Browse the filesystem", hint: "~/" });
      return rows;
    }
    const needle = browse.filter.toLowerCase();
    const matched = entries
      .filter((e) => !needle || e.name.toLowerCase().includes(needle))
      .sort((a, b) => scoreName(a.name, needle) - scoreName(b.name, needle) || a.name.localeCompare(b.name));
    const rows: PickerItem[] = [];
    if (browse.dir.replace(/\/+$/, "")) rows.push({ kind: "up", key: "up", label: "..", hint: parentOf(browse.dir) });
    if (browse.exact) rows.unshift({ kind: "use", key: "use", label: `Use ${basenameOf(browse.exact)}`, hint: browse.exact });
    for (const e of matched) rows.push({ kind: "dir", key: `d:${e.path}`, label: e.name, hint: e.path, entry: e });
    return rows;
  }, [browse, entries, projects]);

  useEffect(() => {
    setHighlight((h) => (items.length === 0 ? 0 : Math.min(h, items.length - 1)));
  }, [items]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-highlighted="true"]')?.scrollIntoView({ block: "nearest" });
  }, [highlight, items]);

  const usePath = useCallback(async (rawPath: string) => {
    const path = rawPath.replace(/\/+$/, "") || rawPath;
    if (!path || creating) return;
    setCreating(true);
    try {
      const project = await ensureProject(path);
      if (project) onPicked(project);
    } finally {
      setCreating(false);
    }
  }, [creating, onPicked]);

  const runItem = useCallback((item: PickerItem | undefined) => {
    if (!item) return;
    if (item.kind === "project") return onPicked(item.project);
    if (item.kind === "browse") return setQuery("~/");
    if (item.kind === "up") return setQuery(`${item.hint.replace(/\/+$/, "")}/`);
    if (item.kind === "use") return void usePath(item.hint);
    setQuery(`${item.hint.replace(/\/+$/, "")}/`); // dir: descend, keep browsing
  }, [onPicked, usePath]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => (items.length ? (h + 1) % items.length : 0)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => (items.length ? (h - 1 + items.length) % items.length : 0)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      // ⌘/Ctrl+Enter opens the typed directory itself instead of descending
      if ((e.metaKey || e.ctrlKey) && browse.browsing) return void usePath(browse.exact || browse.dir);
      runItem(items[highlight]);
    }
  };

  const groupLabel = browse.browsing ? "Directories" : browse.filter ? "Matching projects" : "Projects";

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center px-4 py-[10vh]" onMouseDown={onClose}>
      <div className="dialog-backdrop absolute inset-0" />
      <div
        className="dialog-glass relative flex max-h-[26rem] w-full max-w-xl min-w-0 flex-col overflow-hidden rounded-2xl border"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2.5 px-4 py-3">
          {loading || creating ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <Search className="size-4 shrink-0 text-muted-foreground" />
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setHighlight(0); }}
            placeholder="Search projects, or type a path — ~/projects/my-app"
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-placeholder"
            spellCheck={false}
            autoComplete="off"
          />
          {browse.browsing && (
            <span className="hidden shrink-0 truncate font-mono text-[11px] text-muted-foreground sm:block" title={browse.dir}>
              {browse.dir}
            </span>
          )}
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto border-t border-border p-2">
          {items.length === 0 ? (
            <div className="py-8 text-center text-[13px] text-muted-foreground">
              {dirMissing ? "No such directory" : browse.browsing ? "No folders here" : "No projects yet — type a path to add one"}
            </div>
          ) : (
            <>
              <div className="px-2 pb-1 pt-1 text-[11px] font-medium text-secondary-label">{groupLabel}</div>
              {items.map((item, i) => (
                <PickerRow
                  key={item.key}
                  item={item}
                  highlighted={i === highlight}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => runItem(item)}
                />
              ))}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border bg-foreground/[0.025] px-4 py-2.5 text-[12px] text-muted-foreground">
          <div className="flex items-center gap-3">
            <Hint keys={["↑", "↓"]}>Navigate</Hint>
            <Hint keys={["↵"]}>{browse.browsing ? "Open folder" : "Select"}</Hint>
            {browse.browsing && <Hint keys={["⌘", "↵"]}>Use folder</Hint>}
          </div>
          {device && (
            <span className="flex shrink-0 items-center gap-1.5" title={`${device.name} · ${device.hostname}`}>
              <Server className="size-3" />
              <span className="truncate">{device.name || device.hostname}</span>
              <span className={cn("size-1.5 rounded-full", device.status === "connected" ? "bg-success" : "bg-border")} />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function PickerRow({ item, highlighted, onClick, onMouseEnter }: {
  item: PickerItem;
  highlighted: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
}) {
  const Icon = item.kind === "up" ? CornerLeftUp : item.kind === "use" ? FolderOpen : item.kind === "browse" ? Search : Folder;
  return (
    <button
      type="button"
      data-highlighted={highlighted}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-control px-2 py-1.5 text-left transition-colors",
        highlighted ? "bg-foreground/[0.09] text-foreground" : "text-foreground hover:bg-foreground/[0.06]",
      )}
    >
      <Icon className={cn("size-4 shrink-0", item.kind === "use" ? "text-primary" : "text-muted-foreground")} />
      <span className="min-w-0 flex-1 truncate text-[13px]">{item.label}</span>
      <span className="hidden min-w-0 max-w-[55%] shrink-0 truncate font-mono text-[11px] text-muted-foreground sm:block">{item.hint}</span>
      {highlighted && <CornerDownLeft className="size-3 shrink-0 text-muted-foreground" />}
    </button>
  );
}

function Hint({ keys, children }: { keys: string[]; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="flex items-center gap-1">
        {keys.map((k) => (
          <kbd key={k} className="rounded border border-border bg-foreground/[0.06] px-1.5 py-0.5 font-sans text-[11px] leading-none text-foreground">
            {k}
          </kbd>
        ))}
      </span>
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- helpers */

type PickerItem =
  | { kind: "project"; key: string; label: string; hint: string; project: Project }
  | { kind: "browse"; key: string; label: string; hint: string }
  | { kind: "up"; key: string; label: string; hint: string }
  | { kind: "use"; key: string; label: string; hint: string }
  | { kind: "dir"; key: string; label: string; hint: string; entry: FsEntry };

// mirrors t3code's getFilesystemBrowsePath: split the typed path into the
// directory to list and the trailing segment that filters it.
export function parseBrowseQuery(query: string): { browsing: boolean; dir: string; filter: string; exact: string } {
  const q = query;
  const isPath = q.startsWith("/") || q.startsWith("~") || q.startsWith("./");
  if (!isPath) return { browsing: false, dir: "", filter: q.trim(), exact: "" };
  const idx = q.lastIndexOf("/");
  if (idx < 0) return { browsing: true, dir: q, filter: "", exact: "" };
  const dir = q.slice(0, idx + 1) || "/";
  const filter = q.slice(idx + 1);
  // a trailing slash means the typed path is itself the target folder
  const exact = filter === "" ? q.replace(/\/+$/, "") || "/" : "";
  return { browsing: true, dir, filter, exact };
}

function scoreName(name: string, needle: string) {
  if (!needle) return 0;
  const lower = name.toLowerCase();
  if (lower === needle) return 0;
  if (lower.startsWith(needle)) return 1;
  return 2;
}

function parentOf(dir: string) {
  const clean = dir.replace(/\/+$/, "");
  const idx = clean.lastIndexOf("/");
  if (idx <= 0) return "/";
  return clean.slice(0, idx);
}

function basenameOf(path: string) {
  return path.replace(/\/+$/, "").split("/").filter(Boolean).pop() || path;
}
