import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { UsageView } from "@/components/UsageView";
import { Terminal, type TerminalStatus } from "@/components/Terminal";
import { ProjectPicker } from "@/components/ProjectPicker";
import { PreviewPane } from "@/components/panels/PreviewPane";
import { DiffPane } from "@/components/panels/DiffPane";
import {
  GitBranch, GitCompare, Globe, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen,
  Plus, Terminal as TermIcon, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { asProject, ensureProject, fetchDevices, fetchProjects, fetchSessions, type Device, type Project, type Session } from "@/lib/api";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import type { PanelImperativeHandle } from "react-resizable-panels";

const ACTIVE_ID_KEY = "kusal:activeId";
const DRAFT_PROJECT_KEY = "kusal:draftProject";

type TabType = "preview" | "diff" | "terminal";
type Tab = { id: string; type: TabType };

const TAB_META: Record<TabType, { label: string; icon: typeof Globe }> = {
  preview: { label: "Preview", icon: Globe },
  diff: { label: "Diff", icon: GitCompare },
  terminal: { label: "Terminal", icon: TermIcon },
};

export default function App() {
  const [route, setRoute] = useState<"chat" | "usage">(() => {
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/usage")) {
      return "usage";
    }
    return "chat";
  });

  const navigate = useCallback((target: "chat" | "usage") => {
    setRoute(target);
    const targetUrl = target === "usage" ? "/usage" : "/";
    if (typeof window !== "undefined" && window.location.pathname !== targetUrl) {
      window.history.pushState(null, "", targetUrl);
    }
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const isUsage = window.location.pathname.startsWith("/usage");
      setRoute(isUsage ? "usage" : "chat");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const [activeId, setActiveId] = useState<string | null>(() => {
    try { return localStorage.getItem(ACTIVE_ID_KEY); } catch { return null; }
  });
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>("");
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(true);
  const [sessionsRefresh, setSessionsRefresh] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [shellStatus, setShellStatus] = useState<TerminalStatus>("closed");
  const [projects, setProjects] = useState<Project[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [draftProject, setDraftProject] = useState<Project | null>(() => {
    try {
      const raw = localStorage.getItem(DRAFT_PROJECT_KEY);
      return raw ? asProject(JSON.parse(raw)) : null;
    } catch { return null; }
  });
  const [sessions, setSessions] = useState<Session[]>([]);

  useEffect(() => {
    try {
      if (activeId) localStorage.setItem(ACTIVE_ID_KEY, activeId);
      else localStorage.removeItem(ACTIVE_ID_KEY);
    } catch {}
  }, [activeId]);

  // resolve the active session's project directory, for the Diff tab
  useEffect(() => { fetchSessions().then(setSessions); }, [sessionsRefresh, activeId]);
  const activeCwd = useMemo(() => sessions.find((s) => s.id === activeId)?.cwd ?? "", [sessions, activeId]);

  useEffect(() => {
    fetchProjects().then(setProjects);
    fetchDevices().then(setDevices);
  }, [sessionsRefresh]);

  useEffect(() => {
    try {
      if (draftProject) localStorage.setItem(DRAFT_PROJECT_KEY, JSON.stringify(draftProject));
      else localStorage.removeItem(DRAFT_PROJECT_KEY);
    } catch {}
  }, [draftProject]);

  // ⌘K / ⌘P opens the project picker, like t3code's command palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "p")) {
        e.preventDefault();
        setPickerOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // picking a project opens a fresh draft in it — no session until the first send
  const startDraftIn = useCallback((project: Project) => {
    setDraftProject(project);
    setActiveId(null);
    setProjects((prev) => (prev.some((p) => p.id === project.id || p.path === project.path) ? prev : [project, ...prev]));
    setPickerOpen(false);
    navigate("chat");
  }, [navigate]);

  const startDraftInPath = useCallback(async (cwd: string) => {
    const known = projects.find((p) => p.path === cwd);
    if (known) return startDraftIn(known);
    const created = await ensureProject(cwd);
    if (created) startDraftIn(created);
  }, [projects, startDraftIn]);

  const leftRef = useRef<PanelImperativeHandle>(null);
  const rightRef = useRef<PanelImperativeHandle>(null);

  // when ChatView creates a real opencode session: select it + refresh sidebar
  const onSessionCreated = (id: string) => {
    setActiveId(id);
    navigate("chat");
    setSessionsRefresh((n) => n + 1);
  };

  // v4 API: string sizes are %, numbers are px
  const RIGHT_OPEN_SIZE = "30";

  const hasTerminalTab = tabs.some((t) => t.type === "terminal");
  const terminalLive = hasTerminalTab && shellStatus === "open";
  useEffect(() => { if (!hasTerminalTab) setShellStatus("closed"); }, [hasTerminalTab]);

  const toggleLeft = () => {
    const p = leftRef.current;
    if (!p) return;
    if (p.isCollapsed()) { p.expand(); setLeftCollapsed(false); } else { p.collapse(); setLeftCollapsed(true); }
  };

  const closeRight = useCallback(() => { rightRef.current?.collapse(); setRightCollapsed(true); }, []);

  const openTab = useCallback((type: TabType) => {
    const id = crypto.randomUUID();
    setTabs((t) => [...t, { id, type }]);
    setActiveTabId(id);
    setAddMenuOpen(false);
    rightRef.current?.resize(RIGHT_OPEN_SIZE);
    setRightCollapsed(false);
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((t) => {
      const idx = t.findIndex((x) => x.id === id);
      const next = t.filter((x) => x.id !== id);
      setActiveTabId((cur) => (cur === id ? (next[idx] ?? next[idx - 1] ?? next[0])?.id ?? "" : cur));
      return next;
    });
  }, []);

  // browser-tab-style toolbar buttons: focus an existing tab of this type, open a
  // new one if none exists yet, or collapse the panel if it's already focused
  const ensureTab = (type: TabType) => {
    const existing = tabs.find((t) => t.type === type);
    if (!existing) { openTab(type); return; }
    if (existing.id === activeTabId && !rightCollapsed) { closeRight(); return; }
    setActiveTabId(existing.id);
    rightRef.current?.resize(RIGHT_OPEN_SIZE);
    setRightCollapsed(false);
  };

  const expandRight = () => {
    if (tabs.length === 0) { openTab("preview"); return; }
    rightRef.current?.resize(RIGHT_OPEN_SIZE);
    setRightCollapsed(false);
  };

  useEffect(() => {
    if (tabs.length === 0 && !rightCollapsed) closeRight();
  }, [tabs.length, rightCollapsed, closeRight]);

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <ResizablePanelGroup orientation="horizontal" className="h-screen">
        {/* Left sidebar - collapsible */}
        <ResizablePanel panelRef={leftRef} defaultSize="16" minSize="11" maxSize="35" collapsible collapsedSize={0} className="min-w-0">
          <Sidebar
            activeId={activeId}
            onSelect={(id) => {
              setActiveId(id);
              navigate("chat");
            }}
            refreshSignal={sessionsRefresh}
            onNewThread={() => {
              setPickerOpen(true);
              navigate("chat");
            }}
            onNewThreadIn={startDraftInPath}
            terminalLive={terminalLive}
            onThreadRemoved={(id) => {
              if (activeId === id) setActiveId(null);
              setSessionsRefresh((n) => n + 1);
            }}
            currentView={route}
            onNavigate={navigate}
          />
        </ResizablePanel>

        <ResizableHandle />

        {/* Center */}
        <ResizablePanel defaultSize="60" minSize="30" className="min-w-0">
          {route === "usage" ? (
            <UsageView
              onBack={() => navigate("chat")}
              onToggleLeft={toggleLeft}
              leftCollapsed={leftCollapsed}
            />
          ) : (
            <div className="flex h-full min-w-0 flex-col">
              <div className="flex h-[52px] shrink-0 items-center gap-2 px-3">
                <button
                  onClick={toggleLeft}
                  title={leftCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                  className="rounded-control p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {leftCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
                </button>

                <span className="rounded-control bg-muted px-2 py-1 font-mono text-[11px] text-foreground">kusal/harness</span>
                <span className="flex items-center gap-1 text-[13px] text-muted-foreground">
                  <GitBranch className="size-3.5" /> main
                </span>
                <span className="hidden items-center gap-1.5 text-[13px] text-muted-foreground sm:flex">
                  <span className="size-1.5 rounded-full bg-success" /> opencode running
                </span>

                <div className="ms-auto flex items-center gap-1">
                  <div className="flex rounded-control bg-muted p-0.5">
                    {(["terminal", "preview", "diff"] as TabType[]).map((type) => {
                      const meta = TAB_META[type];
                      const Icon = meta.icon;
                      const tab = tabs.find((t) => t.type === type);
                      const isActive = !!tab && tab.id === activeTabId && !rightCollapsed;
                      return (
                        <button
                          key={type}
                          onClick={() => ensureTab(type)}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-[0.375rem] px-2 py-1 text-xs font-medium transition-colors",
                            isActive ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          <Icon className="size-3.5" /> {meta.label}
                          {type === "terminal" && terminalLive && (
                            <span className="size-1.5 rounded-full bg-success animate-status-pulse" title="shell attached" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    onClick={() => (rightCollapsed ? expandRight() : closeRight())}
                    title={rightCollapsed ? "Expand right panel" : "Collapse right panel"}
                    className="ms-1 rounded-control p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {rightCollapsed ? <PanelRightOpen className="size-4" /> : <PanelRightClose className="size-4" />}
                  </button>
                </div>
              </div>

              <div className="flex min-h-0 flex-1 flex-col">
                <ChatView
                  sessionId={activeId}
                  onSessionCreated={onSessionCreated}
                  project={draftProject}
                  projects={projects}
                  onSelectProject={startDraftIn}
                  onAddProject={() => setPickerOpen(true)}
                  cwd={activeCwd || draftProject?.path || ""}
                />
              </div>
            </div>
          )}
        </ResizablePanel>

        <ResizableHandle className={rightCollapsed ? "hidden" : ""} />

        {/* Right panel - collapsible, browser-tab style (preview / diff / terminal), multiple instances */}
        <ResizablePanel panelRef={rightRef} defaultSize={0} minSize="18" maxSize="55" collapsible collapsedSize={0} className="min-w-0">
          <div className="hidden h-full flex-col border-s border-border bg-card xl:flex">
            <div className="flex h-[52px] shrink-0 items-center gap-1 border-b border-border px-2">
              <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
                {tabs.map((tab) => {
                  const meta = TAB_META[tab.type];
                  const Icon = meta.icon;
                  const active = tab.id === activeTabId;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTabId(tab.id)}
                      className={cn(
                        "group inline-flex shrink-0 items-center gap-1.5 rounded-t-[0.5rem] px-2.5 py-1.5 text-[12px] font-medium transition-colors",
                        active ? "bg-background text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      <Icon className="size-3.5" />
                      {meta.label}
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); closeTab(tab.id); } }}
                        className="ms-1 rounded p-0.5 text-muted-foreground/70 opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100"
                        aria-label={`Close ${meta.label} tab`}
                      >
                        <X className="size-3" />
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="relative ms-1 shrink-0">
                <button
                  onClick={() => setAddMenuOpen((v) => !v)}
                  className="rounded-control p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="New tab"
                >
                  <Plus className="size-4" />
                </button>
                {addMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setAddMenuOpen(false)} />
                    <div className="absolute end-0 top-full z-20 mt-1 w-32 rounded-control border border-border bg-card p-1 shadow-md">
                      {(Object.keys(TAB_META) as TabType[]).map((type) => {
                        const Icon = TAB_META[type].icon;
                        return (
                          <button
                            key={type}
                            onClick={() => openTab(type)}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[12px] text-foreground hover:bg-accent"
                          >
                            <Icon className="size-3.5" /> {TAB_META[type].label}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>

              <button onClick={closeRight} className="ms-1 shrink-0 rounded-control p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Close panel">
                <X className="size-3.5" />
              </button>
            </div>

            <div className="min-h-0 flex-1">
              {tabs.length === 0 && (
                <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-muted-foreground">
                  No tabs open. Use the + button or the toolbar above to open a preview, diff, or terminal.
                </div>
              )}
              {tabs.map((tab) => (
                <div key={tab.id} className={cn("h-full", tab.id !== activeTabId && "hidden")}>
                  {tab.type === "preview" && <PreviewPane id={tab.id} />}
                  {tab.type === "diff" && <DiffPane cwd={activeCwd} />}
                  {tab.type === "terminal" && <Terminal onStatus={setShellStatus} cwd={activeCwd || draftProject?.path || ""} />}
                </div>
              ))}
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      <ProjectPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPicked={startDraftIn}
        projects={projects}
        device={devices.find((d) => d.status === "connected") ?? devices[0] ?? null}
      />
    </div>
  );
}
