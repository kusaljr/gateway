import { useEffect, useMemo, useRef, useState } from "react";
import { File, Folder, Loader2, Search, SlashSquare, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FileHit, OCModel } from "@/lib/api";
import { ProviderGlyph, providerMeta } from "@/components/ProviderGlyph";

/**
 * Composer affordances modelled on t3code's ComposerCommandMenu:
 * `@` opens a workspace file search, `/` opens the command list. Rows are
 * label + muted description, the highlighted one carries the accent surface.
 */
export type Trigger =
  | { kind: "file"; start: number; query: string }
  | { kind: "command"; start: number; query: string };

/** Read the token the caret sits in: `@partial` anywhere, `/partial` at the start. */
export function detectTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const mention = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (mention) return { kind: "file", start: caret - mention[1]!.length - 1, query: mention[1]! };
  const command = before.match(/^\/([a-zA-Z:-]*)$/);
  if (command) return { kind: "command", start: 0, query: command[1]! };
  return null;
}

export type CommandId = "model";

export const COMPOSER_COMMANDS: ReadonlyArray<{ id: CommandId; label: string; description: string }> = [
  { id: "model", label: "/model", description: "Choose the model for this thread" },
];

export type MenuRow = { id: string; label: string; description: string; kind: "file" | "command"; isDir?: boolean };

export function buildRows(trigger: Trigger, files: FileHit[]): MenuRow[] {
  if (trigger.kind === "command") {
    const q = trigger.query.toLowerCase();
    return COMPOSER_COMMANDS.filter((c) => c.id.startsWith(q) || c.label.slice(1).startsWith(q)).map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
      kind: "command",
    }));
  }
  return files.map((f) => ({ id: f.rel, label: f.name, description: f.rel, kind: "file" as const, isDir: f.isDir }));
}

export function ComposerMenu({ trigger, rows, loading, highlight, onHighlight, onAccept }: {
  trigger: Trigger;
  rows: MenuRow[];
  loading: boolean;
  highlight: number;
  onHighlight: (index: number) => void;
  onAccept: (row: MenuRow) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-highlighted="true"]')?.scrollIntoView({ block: "nearest" });
  }, [highlight, rows]);

  return (
    <div className="absolute inset-x-0 bottom-full z-40 mb-2 overflow-hidden rounded-xl border border-border bg-popover shadow-xl shadow-black/10">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        {loading ? <Loader2 className="size-3 shrink-0 animate-spin" /> : trigger.kind === "file" ? <Search className="size-3 shrink-0" /> : <SlashSquare className="size-3 shrink-0" />}
        <span className="min-w-0 truncate">
          {trigger.kind === "file"
            ? trigger.query ? `files matching “${trigger.query}”` : "workspace files"
            : "commands"}
        </span>
        <span className="ms-auto shrink-0 tabular-nums">{rows.length}</span>
      </div>
      <div ref={listRef} className="max-h-64 overflow-y-auto p-1">
        {rows.length === 0 ? (
          <p className="px-3 py-4 text-xs text-secondary-label">
            {loading
              ? "Searching workspace files…"
              : trigger.kind === "file"
                ? "No matching files."
                : "No matching command."}
          </p>
        ) : (
          rows.map((row, i) => (
            <button
              key={`${row.kind}:${row.id}`}
              type="button"
              data-highlighted={i === highlight}
              onMouseMove={() => i !== highlight && onHighlight(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onAccept(row)}
              className={cn(
                "flex w-full cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left",
                i === highlight ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
              )}
            >
              {row.kind === "file" ? (
                row.isDir ? (
                  <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <File className="size-3.5 shrink-0 text-muted-foreground" />
                )
              ) : (
                <SlashSquare className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 max-w-[45%] shrink-0 truncate text-xs font-medium">{row.label}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-secondary-label">{row.description}</span>
            </button>
          ))
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-border bg-foreground/[0.025] px-3 py-1.5 text-[10px] text-muted-foreground">
        <span>↑↓ navigate</span>
        <span>↵ / tab insert</span>
        <span>esc dismiss</span>
      </div>
    </div>
  );
}

/* ───────────────────────── T3-style Provider / Model utilities ───────────────────────── */

// providerMeta and ProviderGlyph now live in components/ProviderGlyph.tsx, so
// the picker, the sidebar and the chat header all draw a provider the same way
// — and from the real brand marks rather than three separate sets of initials
// pills that had already drifted apart from each other.

/* ───────────────────────── ModelPickerPopover — T3 exact clone ───────────────────────── */

/** Opened by `/model`: provider rail + searchable model list, like t3code's picker. */
export function ModelPickerPopover({ models, model, onPick, onClose }: {
  models: OCModel[];
  model: OCModel | undefined;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<string | null>(model?.providerID ?? null);
  const [highlight, setHighlight] = useState(0);
  const [favorites, setFavorites] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("kusal:modelFavorites") || "[]"); } catch { return []; }
  });
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const providers = useMemo(() => Array.from(new Set(models.map((m) => m.providerID))).sort(), [models]);
  const normalized = query.trim().toLowerCase();

  const favSet = useMemo(() => new Set(favorites), [favorites]);

  const filtered = useMemo(() => {
    let list = models;
    if (normalized) {
      return list
        .map((m) => {
          const hay = `${m.providerID} ${m.modelID} ${m.label}`.toLowerCase();
          // token fuzzy like t3: split query into tokens, all must be in hay
          const tokens = normalized.split(/\s+/).filter(Boolean);
          const score = tokens.every((t) => hay.includes(t)) ? tokens.length : -1;
          return { m, score };
        })
        .filter((x) => x.score >= 0)
        .sort((a, b) => {
          const af = favSet.has(`${a.m.providerID}/${a.m.modelID}`) ? 0 : 1;
          const bf = favSet.has(`${b.m.providerID}/${b.m.modelID}`) ? 0 : 1;
          if (af !== bf) return af - bf;
          if (a.score !== b.score) return b.score - a.score;
          return a.m.modelID.localeCompare(b.m.modelID);
        })
        .map((x) => x.m);
    }
    if (provider === "__favorites") {
      return models.filter((m) => favSet.has(`${m.providerID}/${m.modelID}`));
    }
    if (provider) return models.filter((m) => m.providerID === provider);
    return [...models].sort((a, b) => {
      const af = favSet.has(`${a.providerID}/${a.modelID}`) ? 0 : 1;
      const bf = favSet.has(`${b.providerID}/${b.modelID}`) ? 0 : 1;
      if (af !== bf) return af - bf;
      return a.modelID.localeCompare(b.modelID);
    });
  }, [models, normalized, provider, favSet]);

  useEffect(() => setHighlight(0), [normalized, provider]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  // focus search like t3
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const toggleFavorite = (key: string, e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    setFavorites((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      try { localStorage.setItem("kusal:modelFavorites", JSON.stringify(next)); } catch {}
      return next;
    });
  };

  const accept = (index: number) => {
    const hit = filtered[index];
    if (hit) onPick(`${hit.providerID}/${hit.modelID}`);
  };

  const activeKey = model ? `${model.providerID}/${model.modelID}` : "";

  return (
    <div
      ref={ref}
      data-model-picker-content="true"
      className="absolute bottom-full left-0 z-40 mb-2 w-90 max-w-[92vw] overflow-hidden rounded-xl border border-border bg-popover shadow-xl shadow-black/10"
    >
      <div className="flex h-screen max-h-86.5 w-full flex-row overflow-hidden">
        {/* Provider rail — t3: w-11, star favorites + per-provider glyph buttons, selected indicator */}
        <div className="w-11 shrink-0 overflow-hidden bg-muted/30" data-model-picker-sidebar="true">
          <div className="flex h-full flex-col gap-1 overflow-y-auto p-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <button
              onClick={() => { setProvider("__favorites"); setQuery(""); }}
              aria-label="Favorites"
              className={cn(
                "relative flex aspect-square w-full items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                provider === "__favorites" && !normalized && "bg-background text-foreground shadow-sm",
              )}
            >
              <Star className={cn("size-5", favSet.size > 0 && provider === "__favorites" ? "fill-current" : "")} />
            </button>
            <div className="border-b border-border/70" aria-hidden />
            {providers.map((p) => {
              const isSelected = provider === p && !normalized;
              return (
                <button
                  key={p}
                  onClick={() => { setProvider(p); setQuery(""); }}
                  aria-label={p}
                  title={p}
                  className={cn(
                    "relative flex aspect-square w-full items-center justify-center rounded-md transition-colors hover:bg-accent",
                    isSelected ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
                  )}
                >
                  <ProviderGlyph providerID={p} size={22} />
                  {isSelected && <span className="pointer-events-none absolute -right-1 top-1/2 h-5 w-0.75 -translate-y-1/2 rounded-l-full bg-primary" />}
                </button>
              );
            })}
            <button
              onClick={() => { setProvider(null); setQuery(""); }}
              aria-label="All"
              className={cn(
                "relative flex aspect-square w-full items-center justify-center rounded-md text-[10px] font-bold transition-colors hover:bg-accent",
                !provider && !normalized ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
              )}
            >
              All
            </button>
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-border/70 bg-muted/40">
          {/* Search — flush underline, no boxed pill */}
          <div className="px-2 pt-2">
            <div className="flex items-center gap-2 border-b border-border/70 pb-2.5 transition-colors focus-within:border-ring">
              <Search className="size-4 shrink-0 text-muted-foreground opacity-70" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { e.preventDefault(); onClose(); }
                  if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => (filtered.length ? (h + 1) % filtered.length : 0)); }
                  if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => (filtered.length ? (h - 1 + filtered.length) % filtered.length : 0)); }
                  if (e.key === "Enter") { e.preventDefault(); accept(highlight); }
                }}
                placeholder="Search models..."
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
              />
            </div>
          </div>

          {/* Model list */}
          <div className="min-h-0 flex-1 overflow-y-auto py-1.5 pl-2 pr-px">
            {filtered.length === 0 ? (
              <p className="py-6 text-center text-xs font-normal leading-snug text-muted-foreground">No models found</p>
            ) : (
              filtered.map((m, i) => {
                const key = `${m.providerID}/${m.modelID}`;
                const active = key === activeKey;
                const isFav = favSet.has(key);
                const isHighlighted = i === highlight;
                return (
                  <button
                    key={key}
                    data-highlighted={isHighlighted}
                    onMouseMove={() => i !== highlight && setHighlight(i)}
                    onClick={() => onPick(key)}
                    className={cn(
                      "group relative mb-0.5 flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors",
                      isHighlighted && "bg-accent",
                      !isHighlighted && "hover:bg-accent",
                      active && "bg-foreground/[0.08] text-foreground",
                    )}
                  >
                    <ProviderGlyph providerID={m.providerID} size={18} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium leading-snug text-foreground">{m.modelID}</div>
                      <div className="mt-1 flex items-center gap-1.5">
                        <span className="truncate text-xs font-normal leading-snug text-muted-foreground/70">{providerMeta(m.providerID).label}</span>
                      </div>
                    </div>
                    <button
                      aria-label={isFav ? "Remove from favorites" : "Add to favorites"}
                      onClick={(e) => toggleFavorite(key, e)}
                      className={cn(
                        "-mr-1 shrink-0 rounded p-1 text-muted-foreground/70 opacity-64 transition-[color,opacity] hover:text-foreground hover:opacity-100 group-hover:opacity-100",
                        isFav && "text-foreground opacity-100",
                      )}
                    >
                      <Star className={cn("size-3.5", isFav && "fill-current text-yellow-500")} />
                    </button>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
