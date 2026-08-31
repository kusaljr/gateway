import {
  Archive, ArchiveRestore, ChevronDown, ChevronRight, ClipboardCopy, Folder, GitBranch,
  Pencil, Plus, Search, Server, Shield, SquarePen, Terminal as TermIcon, Trash2, X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn, relativeTime } from "@/lib/utils";
import { archiveSession, backendOf, deleteSession, fetchDevices, fetchSessions, renameSession, type Session } from "@/lib/api";
import { buildThreadTree, collectKeys, keysForSession, shortModel, type DirNode } from "@/lib/threadTree";
import { ProviderGlyph, providerMeta } from "@/components/ProviderGlyph";
import { useSessionStatuses } from "@/lib/useSessionStatuses";

const COLLAPSED_KEY = "kusal:sidebarCollapsed";
const SECTIONS_KEY = "kusal:sidebarSections";

type Props = {
  activeId: string | null;
  onSelect: (id: string) => void;
  refreshSignal?: number;
  /** open the project picker (⌘K) */
  onNewThread?: () => void;
  /** start a draft in an already-known project directory */
  onNewThreadIn?: (cwd: string) => void;
  /** the shared shell is attached — shown on the active thread and in the footer */
  terminalLive?: boolean;
  /** a thread left the list (deleted or archived) — clear it if it was open */
  onThreadRemoved?: (id: string) => void;
};

export function Sidebar({ activeId, onSelect, refreshSignal = 0, onNewThread, onNewThreadIn, terminalLive = false, onThreadRemoved }: Props) {
  const [devices, setDevices] = useState<Awaited<ReturnType<typeof fetchDevices>>>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState<{ session: Session; x: number; y: number } | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  // The two top-level sections fold away too. Threads is the one that matters
  // on a device with a long list, but devices is a fixed-height block sitting
  // above it and reclaiming that space is the whole point.
  const [sections, setSections] = useState<{ devices: boolean; threads: boolean }>(() => {
    try {
      const raw = localStorage.getItem(SECTIONS_KEY);
      const parsed = raw ? (JSON.parse(raw) as Partial<{ devices: boolean; threads: boolean }>) : {};
      return { devices: parsed.devices ?? true, threads: parsed.threads ?? true };
    } catch { return { devices: true, threads: true }; }
  });
  const toggleSection = useCallback(
    (key: "devices" | "threads") => setSections((prev) => ({ ...prev, [key]: !prev[key] })),
    [],
  );
  const [pending, setPending] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_KEY);
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    } catch { return new Set<string>(); }
  });

  useEffect(() => {
    fetchDevices().then(setDevices);
    fetchSessions().then(setSessions);
  }, [refreshSignal]);

  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch {}
  }, [collapsed]);

  useEffect(() => {
    try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(sections)); } catch {}
  }, [sections]);

  // Live run state, so "working" reflects the thread that is actually running
  // rather than whatever sqlite last recorded.
  //
  // The two backends have to be read differently, and conflating them is what
  // left a thread pinned to "working" forever. opencode publishes /session/status
  // and its own events, so for an opencode thread the live map is authoritative
  // in BOTH directions — including its silence, which means the optimistic
  // "working" row written when the turn was queued is stale and the turn is long
  // over. A CLI agent (Claude Code, Codex, …) publishes nothing there at all, so
  // its absence from the map says nothing and the DB row is the only truth.
  const { statuses, ready: statusesReady } = useSessionStatuses();
  const liveSessions = useMemo(
    () =>
      sessions.map((s) => {
        const state = statuses[s.id];
        const isOpencode = backendOf(s.provider) === "opencode";
        if (!isOpencode) return s;
        if (state === "busy" || state === "retry") return { ...s, status: "working" as const };
        if (state === "idle" && s.status === "working") return { ...s, status: "idle" as const };
        if (statusesReady && !state && s.status === "working") return { ...s, status: "idle" as const };
        return s;
      }),
    [sessions, statuses, statusesReady],
  );

  const needle = q.trim().toLowerCase();
  const filtered = useMemo(
    () => liveSessions.filter((s) => !needle || `${s.title} ${s.cwd} ${s.model} ${s.branch ?? ""}`.toLowerCase().includes(needle)),
    [liveSessions, needle],
  );
  const live = useMemo(() => filtered.filter((s) => !s.archived), [filtered]);
  const archived = useMemo(() => filtered.filter((s) => s.archived), [filtered]);
  const { roots, prefix } = useMemo(() => buildThreadTree(live), [live]);

  const removeLocal = useCallback((id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    onThreadRemoved?.(id);
  }, [onThreadRemoved]);

  const onArchive = useCallback(async (session: Session, archive: boolean) => {
    setPending(session.id);
    try {
      await archiveSession(session.id, archive);
      setSessions((prev) => prev.map((s) => (s.id === session.id ? { ...s, archived: archive } : s)));
      if (archive) onThreadRemoved?.(session.id);
    } catch (e) {
      console.error(e);
    } finally {
      setPending(null);
      setMenu(null);
    }
  }, [onThreadRemoved]);

  const onRename = useCallback(async (session: Session, title: string) => {
    const next = title.trim();
    setRenamingId(null);
    if (!next || next === session.title) return;
    setSessions((prev) => prev.map((s) => (s.id === session.id ? { ...s, title: next } : s)));
    try {
      await renameSession(session.id, next);
    } catch (e) {
      console.error(e);
      // put the old title back if the server rejected it
      setSessions((prev) => prev.map((s) => (s.id === session.id ? { ...s, title: session.title } : s)));
    }
  }, []);

  const onDelete = useCallback(async (session: Session) => {
    setPending(session.id);
    try {
      await deleteSession(session.id);
      removeLocal(session.id);
    } catch (e) {
      console.error(e);
    } finally {
      setPending(null);
      setMenu(null);
    }
  }, [removeLocal]);

  // Opening a thread reveals the folders above it — ONCE, by un-collapsing
  // them, rather than by overriding the toggle for as long as it stays open.
  // The override is what made folders uncollapsable: clicking one added it to
  // `collapsed`, and this recomputed it right back to open on the next render,
  // so the chevron flipped and nothing moved. Every path leading to the active
  // thread was affected, which is most of the tree most of the time.
  //
  // Keyed on the thread, not on `roots`: the tree object is rebuilt by every
  // poll, and re-running this on each one would re-expand what the user had
  // just collapsed.
  const revealedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!activeId) return;
    if (revealedFor.current === activeId) return;
    const keys = keysForSession(roots, activeId);
    // roots may not hold this thread yet on a cold load — leave it unrevealed
    // and let the next tree rebuild try again
    if (!keys?.length) return;
    revealedFor.current = activeId;
    setCollapsed((prev) => {
      if (!keys.some((k) => prev.has(k))) return prev;
      const next = new Set(prev);
      for (const k of keys) next.delete(k);
      return next;
    });
  }, [activeId, roots]);

  // Search is the one real override, and it is transient: while a query is
  // typed every folder opens so matches are visible, and the moment it clears
  // the tree returns to exactly the shape the user had arranged.
  const searchOpen = useMemo(() => (needle ? new Set(collectKeys(roots)) : null), [needle, roots]);

  const isOpen = (key: string) => (searchOpen ? searchOpen.has(key) : !collapsed.has(key));
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const connected = devices.filter((d) => d.status === "connected").length;
  const workingTotal = liveSessions.filter((s) => s.status === "working").length;

  return (
    <div className="flex h-full w-full min-w-0 flex-col border-e border-border bg-sidebar">
      <div className="flex h-[52px] shrink-0 items-center gap-2 px-3">
        <div className="flex size-6 items-center justify-center rounded-md bg-primary text-[11px] font-semibold text-primary-foreground">K</div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium leading-tight text-foreground">kusal</div>
          <div className="flex items-center gap-1.5 truncate text-[11px] leading-tight text-muted-foreground">
            {workingTotal > 0 ? (
              <>
                <span className="size-1.5 shrink-0 rounded-full bg-info animate-status-pulse" />
                {workingTotal} working
              </>
            ) : (
              "tunnel sessions"
            )}
          </div>
        </div>
        <button
          onClick={onNewThread}
          title="New thread  (⌘K)"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-control text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="New thread"
        >
          <SquarePen className="size-4" />
        </button>
      </div>

      <div className="px-2 pb-2">
        <div className="flex items-center gap-2 rounded-control bg-sidebar-control px-2 py-1.5 transition-colors focus-within:bg-card focus-within:ring-1 focus-within:ring-border">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search threads"
            className="w-full bg-transparent text-[13px] outline-none placeholder:text-placeholder"
          />
          {q && (
            <button onClick={() => setQ("")} className="shrink-0 text-muted-foreground hover:text-foreground" aria-label="Clear search">
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>

      <div className="px-2 pb-2">
        <SectionLabel
          icon={Server}
          label="devices"
          trailing={`${connected}/${devices.length}`}
          open={sections.devices}
          onToggle={() => toggleSection("devices")}
        />
        {sections.devices && devices.length === 0 && (
          <div className="rounded-control border border-dashed border-border px-2.5 py-3 text-center text-[11px] leading-relaxed text-muted-foreground">
            No devices yet — run <code className="rounded bg-card px-1 py-0.5 text-[10px]">kusal connect</code>
          </div>
        )}
        {sections.devices && devices.map((d) => {
          const isConnected = d.status === "connected";
          return (
            <div
              key={d.id}
              title={`${d.name} (${d.hostname}) · ${d.status} · tunnel ${d.tunnel_id} · last seen ${d.last_seen}`}
              className="flex items-center gap-2 rounded-control px-2.5 py-1.5 transition-colors hover:bg-sidebar-row-hover"
            >
              <span className={cn("size-1.5 shrink-0 rounded-full", isConnected ? "bg-success animate-status-pulse" : "bg-border")} />
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{d.name || d.id.slice(0, 8)}</span>
              <span className={cn("shrink-0 text-[11px] tabular-nums", isConnected ? "text-success-foreground" : "text-muted-foreground")}>
                {isConnected ? relativeTime(d.last_seen) : d.status}
              </span>
            </div>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <SectionLabel
          icon={Folder}
          label="threads"
          trailing={String(live.length)}
          open={sections.threads}
          onToggle={() => toggleSection("threads")}
          {...(prefix ? { hint: prefix } : {})}
        />
        {!sections.threads ? null : roots.length === 0 ? (
          <div className="px-2 py-6 text-center text-[13px] text-muted-foreground">{needle ? "No matching threads" : "No threads yet"}</div>
        ) : (
          roots.map((node) => (
            <TreeDir
              key={node.key}
              node={node}
              depth={0}
              open={isOpen(node.key)}
              isOpen={isOpen}
              onToggle={toggle}
              activeId={activeId}
              onSelect={onSelect}
              {...(onNewThreadIn ? { onNewThreadIn } : {})}
              terminalLive={terminalLive}
              onContextMenu={(session, x, y) => setMenu({ session, x, y })}
              renamingId={renamingId}
              onRename={onRename}
              onCancelRename={() => setRenamingId(null)}
            />
          ))
        )}

        {sections.threads && archived.length > 0 && (
          <div className="mt-2 border-t border-border pt-1">
            <button
              onClick={() => setArchivedOpen((v) => !v)}
              className="flex w-full items-center gap-1.5 rounded-control px-2.5 py-1 text-[11px] font-medium text-secondary-label transition-colors hover:bg-sidebar-row-hover"
            >
              {archivedOpen ? <ChevronDown className="size-3 shrink-0 opacity-65" /> : <ChevronRight className="size-3 shrink-0 opacity-65" />}
              <Archive className="size-3 shrink-0 opacity-70" />
              <span>archived</span>
              <span className="ms-auto shrink-0 tabular-nums text-muted-foreground/70">{archived.length}</span>
            </button>
            {archivedOpen && (
              <div className="ms-[11px] border-s border-border/60 ps-1">
                {archived.map((s) => (
                  <ThreadRow
                    key={s.id}
                    s={s}
                    active={s.id === activeId}
                    onSelect={onSelect}
                    terminalLive={terminalLive}
                    onContextMenu={(session, x, y) => setMenu({ session, x, y })}
                    renamingId={renamingId}
                    onRename={onRename}
                    onCancelRename={() => setRenamingId(null)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border p-2">
        <div
          className="mb-1 flex items-center gap-2 rounded-control px-2 py-1.5 text-[11px]"
          title={terminalLive ? "Shell attached over the tunnel" : "No shell attached — open a Terminal tab"}
        >
          <TermIcon className={cn("size-3.5 shrink-0", terminalLive ? "text-success-foreground" : "text-muted-foreground")} />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{terminalLive ? "shell attached" : "shell idle"}</span>
          <span className={cn("size-1.5 shrink-0 rounded-full", terminalLive ? "bg-success animate-status-pulse" : "bg-border")} />
        </div>
        {(() => {
          const primary = devices.find((d) => d.status === "connected") ?? devices[0];
          if (!primary) {
            return (
              <div className="flex items-center gap-2 rounded-control px-2 py-1.5 text-[11px] text-muted-foreground">
                <Shield className="size-4 shrink-0" />
                <span>Not authenticated — run kusal connect</span>
              </div>
            );
          }
          const shortAccount = primary.tunnel_id ? `${primary.tunnel_id.slice(0, 8)}…` : primary.id.slice(0, 8);
          return (
            <div
              className="flex items-center gap-2 rounded-control px-2 py-1.5 transition-colors hover:bg-sidebar-row-hover"
              title={`Cloudflare account ${primary.tunnel_id} · device ${primary.name}`}
            >
              <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-orange-500/10 text-orange-600">
                <Shield className="size-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium leading-tight text-foreground">Cloudflare Access</div>
                <div className="truncate text-[11px] leading-tight text-muted-foreground">{primary.name} · {shortAccount}</div>
              </div>
              <span className="size-1.5 shrink-0 rounded-full bg-success" />
            </div>
          );
        })()}
      </div>

      {menu && (
        <ThreadContextMenu
          session={menu.session}
          x={menu.x}
          y={menu.y}
          busy={pending === menu.session.id}
          onClose={() => setMenu(null)}
          onStartRename={() => { setRenamingId(menu.session.id); setMenu(null); }}
          onArchive={() => onArchive(menu.session, !menu.session.archived)}
          onDelete={() => onDelete(menu.session)}
          {...(onNewThreadIn ? { onNewThreadIn } : {})}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- tree */

function TreeDir({ node, depth, open, isOpen, onToggle, activeId, onSelect, onNewThreadIn, terminalLive, onContextMenu, renamingId, onRename, onCancelRename }: {
  node: DirNode;
  depth: number;
  open: boolean;
  isOpen: (key: string) => boolean;
  onToggle: (key: string) => void;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewThreadIn?: (cwd: string) => void;
  terminalLive: boolean;
  onContextMenu: (session: Session, x: number, y: number) => void;
  renamingId: string | null;
  onRename: (session: Session, title: string) => void;
  onCancelRename: () => void;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  const isLeaf = node.children.length === 0;
  return (
    <div className="min-w-0">
      <div className="group/dir flex items-center rounded-control transition-colors hover:bg-sidebar-row-hover">
        <button
          onClick={() => onToggle(node.key)}
          title={node.path}
          className="flex min-w-0 flex-1 items-center gap-1 px-1.5 py-1 text-left"
        >
          <Chevron className="size-3 shrink-0 text-muted-foreground/65" />
          <Folder className={cn("size-3 shrink-0", isLeaf ? "text-muted-foreground" : "text-muted-foreground/70")} />
          <span className="min-w-0 truncate text-[12px] font-medium text-foreground">{node.label}</span>
          {node.working > 0 && (
            <span
              className="ms-1.5 flex shrink-0 items-center gap-1 text-[10px] tabular-nums text-info-foreground"
              title={`${node.working} working`}
            >
              <span className="size-1.5 rounded-full bg-info animate-status-pulse" />
              {node.working}
            </span>
          )}
          <span className={cn("shrink-0 text-[10px] tabular-nums text-muted-foreground/60", node.working > 0 ? "ms-1" : "ms-1.5")} title={`${node.total} threads`}>
            {node.total}
          </span>
        </button>
        {onNewThreadIn && (
          <button
            onClick={() => onNewThreadIn(node.path)}
            title={`New thread in ${node.path}`}
            className="me-1 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/dir:opacity-100"
            aria-label="New thread here"
          >
            <Plus className="size-3" />
          </button>
        )}
      </div>

      {open && (
        <div className="ms-[11px] min-w-0 border-s border-border/60 ps-1">
          {node.children.map((child) => (
            <TreeDir
              key={child.key}
              node={child}
              depth={depth + 1}
              open={isOpen(child.key)}
              isOpen={isOpen}
              onToggle={onToggle}
              activeId={activeId}
              onSelect={onSelect}
              {...(onNewThreadIn ? { onNewThreadIn } : {})}
              terminalLive={terminalLive}
              onContextMenu={onContextMenu}
              renamingId={renamingId}
              onRename={onRename}
              onCancelRename={onCancelRename}
            />
          ))}
          {node.threads.map((s) => (
            <ThreadRow
              key={s.id}
              s={s}
              active={s.id === activeId}
              onSelect={onSelect}
              terminalLive={terminalLive}
              onContextMenu={onContextMenu}
              renamingId={renamingId}
              onRename={onRename}
              onCancelRename={onCancelRename}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ThreadRow({ s, active, onSelect, terminalLive, onContextMenu, renaming, renamingId, onRename, onCancelRename }: {
  s: Session;
  active: boolean;
  onSelect: (id: string) => void;
  terminalLive: boolean;
  onContextMenu: (session: Session, x: number, y: number) => void;
  /** set by the tree; the archived list passes renamingId instead */
  renaming?: boolean;
  renamingId?: string | null;
  onRename: (session: Session, title: string) => void;
  onCancelRename: () => void;
}) {
  const isRenaming = renaming ?? renamingId === s.id;
  // the agent's own mark, not a lucide stand-in — six backends used to render
  // as two generic glyphs
  const model = shortModel(s.model);
  // the shared shell belongs to whichever thread is open
  const showTerminal = active && terminalLive;

  const working = s.status === "working";
  const meta = (
    <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
      {working && (
        <span className="flex shrink-0 items-center gap-1 text-info-foreground" title={`${providerMeta(s.provider).label} is working on this thread`}>
          <span className="size-1.5 rounded-full bg-info animate-status-pulse" />
          working
        </span>
      )}
      {model && (
        <span
          className="min-w-0 max-w-[60%] shrink-0 truncate rounded bg-accent/70 px-1 py-px font-mono text-[10px] text-muted-foreground"
          title={`model ${s.model} — fixed for this thread`}
        >
          {model}
        </span>
      )}
      {s.branch && (
        <span className="flex min-w-0 items-center gap-0.5">
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate">{s.branch}</span>
        </span>
      )}
      <span className="ms-auto shrink-0 tabular-nums">{relativeTime(s.updatedAt)}</span>
    </div>
  );

  // rename swaps the row out of its <button> so the input owns keys and focus
  if (isRenaming) {
    return (
      <div className="min-w-0">
        <div className="flex w-full items-start gap-2 rounded-control bg-sidebar-row-selected px-1.5 py-1.5 ring-1 ring-border">
          <StatusDot status={s.status} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <ProviderGlyph providerID={s.provider} size={13} />
              <input
                autoFocus
                defaultValue={s.title}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => onRename(s, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); onRename(s, e.currentTarget.value); }
                  if (e.key === "Escape") { e.preventDefault(); onCancelRename(); }
                }}
                aria-label="Thread title"
                className="min-w-0 flex-1 rounded-[0.25rem] border border-ring/60 bg-card px-1 py-px text-[13px] leading-5 text-foreground outline-none ring-2 ring-ring/25"
              />
            </div>
            {meta}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <button
        onClick={() => onSelect(s.id)}
        onContextMenu={(e) => { e.preventDefault(); onContextMenu(s, e.clientX, e.clientY); }}
        title={`${s.title}\n${s.cwd}\nmodel ${s.model || "—"} · ${s.status}\nright-click for actions`}
        className={cn(
          "group flex w-full items-start gap-2 rounded-control px-1.5 py-1.5 text-left transition-colors",
          active ? "bg-sidebar-row-selected shadow-sm ring-1 ring-border" : "hover:bg-sidebar-row-hover",
          s.archived && "opacity-60",
        )}
      >
        <StatusDot status={s.status} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <ProviderGlyph providerID={s.provider} size={13} className={active ? undefined : "opacity-80"} />
            <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-foreground">{s.title}</span>
            {showTerminal && (
              <TermIcon className="size-3 shrink-0 text-success-foreground animate-status-pulse" aria-label="shell attached" />
            )}
          </div>
          {meta}
        </div>
      </button>
    </div>
  );
}

/* ------------------------------------------------------------ context menu */

function ThreadContextMenu({ session, x, y, busy, onClose, onStartRename, onArchive, onDelete, onNewThreadIn }: {
  session: Session;
  x: number;
  y: number;
  busy: boolean;
  onClose: () => void;
  onStartRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onNewThreadIn?: (cwd: string) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // measure instead of guessing: the confirm step makes the menu taller
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
    });
  }, [x, y, confirmDelete]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onDown = () => onClose();
    document.addEventListener("keydown", onKey);
    // capture so a click anywhere (including other rows) dismisses first
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-50 w-58 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-xl shadow-black/10"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="px-2 pb-1.5 pt-1">
        <div className="truncate text-[13px] font-medium text-foreground" title={session.title}>{session.title}</div>
        <div className="truncate font-mono text-[10px] text-muted-foreground" title={session.cwd}>{session.cwd}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span>{session.archived ? "archived" : session.status}</span>
          {session.model && <span className="truncate font-mono">· {shortModel(session.model)}</span>}
        </div>
      </div>
      <div className="my-1 h-px bg-border" />

      {onNewThreadIn && (
        <MenuItem icon={Plus} onClick={() => { onNewThreadIn(session.cwd); onClose(); }}>
          New thread here
        </MenuItem>
      )}
      <MenuItem icon={Pencil} onClick={onStartRename}>
        Rename thread
      </MenuItem>
      <MenuItem icon={ClipboardCopy} onClick={() => { void navigator.clipboard?.writeText(session.cwd); onClose(); }}>
        Copy path
      </MenuItem>
      <MenuItem icon={session.archived ? ArchiveRestore : Archive} disabled={busy} onClick={onArchive}>
        {session.archived ? "Restore thread" : "Archive thread"}
      </MenuItem>

      <div className="my-1 h-px bg-border" />
      <MenuItem
        icon={Trash2}
        destructive
        disabled={busy}
        onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
      >
        {confirmDelete ? "Click again to delete" : "Delete thread"}
      </MenuItem>
      {confirmDelete && (
        <p className="px-2 pb-1 pt-0.5 text-[10px] leading-snug text-muted-foreground">
          Removes the thread and its opencode history. Cannot be undone.
        </p>
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, children, onClick, destructive, disabled }: {
  icon: typeof Archive;
  children: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-[13px] transition-colors disabled:opacity-50",
        destructive ? "text-error-foreground hover:bg-error/10" : "text-foreground hover:bg-accent/60",
      )}
    >
      <Icon className="size-3.5 shrink-0 opacity-80" />
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}

function StatusDot({ status }: { status: Session["status"] }) {
  const tone =
    status === "working" ? "bg-info animate-status-pulse"
    : status === "done" ? "bg-success"
    : status === "failed" ? "bg-error"
    : "bg-border";
  return <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", tone)} title={status} />;
}

function SectionLabel({ icon: Icon, label, trailing, hint, open, onToggle }: {
  icon: typeof Server;
  label: string;
  trailing?: string;
  hint?: string;
  /** omitted for a section that has nothing to fold away */
  open?: boolean;
  onToggle?: () => void;
}) {
  const body = (
    <>
      {onToggle ? (
        open ? <ChevronDown className="size-3 shrink-0 opacity-65" /> : <ChevronRight className="size-3 shrink-0 opacity-65" />
      ) : null}
      <Icon className="size-3 shrink-0 opacity-70" />
      <span className="shrink-0">{label}</span>
      {hint && (
        <span className="min-w-0 truncate font-mono text-[10px] font-normal text-muted-foreground/60" title={`all threads live under ${hint}`}>
          {hint}
        </span>
      )}
      {trailing && <span className="ms-auto shrink-0 tabular-nums text-muted-foreground/70">{trailing}</span>}
    </>
  );
  const className = "flex w-full items-center gap-1.5 px-2.5 pb-1 pt-2 text-[11px] font-medium text-secondary-label";
  if (!onToggle) return <div className={className}>{body}</div>;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn(className, "rounded-control text-left transition-colors hover:bg-sidebar-row-hover")}
    >
      {body}
    </button>
  );
}
