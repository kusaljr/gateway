import type { Session } from "@/lib/api";

/**
 * Sidebar grouping: build a directory tree out of session cwds so threads sit
 * under the folders they run in, then compact single-child chains the way file
 * explorers do (`Users/macbook/projects` renders as one row, not three).
 */
export type DirNode = {
  key: string;
  /** compacted label, e.g. "projects/harness" */
  label: string;
  path: string;
  depth: number;
  children: DirNode[];
  threads: Session[];
  /** threads in this subtree */
  total: number;
  working: number;
  lastActivity: number;
};

type Draft = {
  segment: string;
  path: string;
  children: Map<string, Draft>;
  threads: Session[];
};

const time = (iso: string | undefined) => {
  const t = new Date(iso ?? "").getTime();
  return Number.isNaN(t) ? 0 : t;
};

export type ThreadTree = {
  roots: DirNode[];
  /** shared ancestor stripped off the rows, e.g. "/Users/macbook" */
  prefix: string;
};

export function buildThreadTree(sessions: Session[]): ThreadTree {
  const entries: Array<{ session: Session; segments: string[] }> = [];
  for (const session of sessions) {
    const cwd = session.cwd?.trim();
    if (!cwd || cwd === "Unknown project") continue; // legacy agent-history artefacts
    const segments = cwd.replace(/\/+$/, "").split("/").filter(Boolean);
    if (segments.length > 0) entries.push({ session, segments });
  }
  if (entries.length === 0) return { roots: [], prefix: "" };

  // hide the ancestor every thread shares (~/, /Users/you) so the tree starts
  // where the paths actually diverge — always keeping each path's own folder
  const shared = sharedPrefix(entries.map((e) => e.segments));
  const shallowest = Math.min(...entries.map((e) => e.segments.length));
  const strip = Math.max(0, Math.min(shared, shallowest - 1));

  const root: Draft = { segment: "", path: "", children: new Map(), threads: [] };
  for (const { session, segments } of entries) {
    let node = root;
    let path = `/${segments.slice(0, strip).join("/")}`.replace(/\/+$/, "");
    for (const segment of segments.slice(strip)) {
      path = `${path}/${segment}`;
      let next = node.children.get(segment);
      if (!next) {
        next = { segment, path, children: new Map(), threads: [] };
        node.children.set(segment, next);
      }
      node = next;
    }
    node.threads.push(session);
  }

  return {
    roots: Array.from(root.children.values())
      .map((child) => finalize(child, 0))
      .sort(byActivity),
    prefix: strip > 0 ? `/${entries[0]!.segments.slice(0, strip).join("/")}` : "",
  };
}

function sharedPrefix(paths: string[][]): number {
  if (paths.length === 0) return 0;
  const first = paths[0]!;
  let n = 0;
  while (n < first.length && paths.every((p) => p[n] === first[n])) n += 1;
  return n;
}

function finalize(draft: Draft, depth: number): DirNode {
  // compact: a folder that only passes through to one child becomes one row
  let label = draft.segment;
  let current = draft;
  while (current.threads.length === 0 && current.children.size === 1) {
    const [only] = current.children.values();
    label = `${label}/${only.segment}`;
    current = only;
  }

  const children = Array.from(current.children.values())
    .map((child) => finalize(child, depth + 1))
    .sort(byActivity);

  const threads = current.threads.slice().sort((a, b) => {
    const aWorking = a.status === "working" ? 0 : 1;
    const bWorking = b.status === "working" ? 0 : 1;
    return aWorking - bWorking || time(b.updatedAt) - time(a.updatedAt);
  });

  const total = threads.length + children.reduce((n, c) => n + c.total, 0);
  const working =
    threads.filter((t) => t.status === "working").length + children.reduce((n, c) => n + c.working, 0);
  const lastActivity = Math.max(
    0,
    ...threads.map((t) => time(t.updatedAt)),
    ...children.map((c) => c.lastActivity),
  );

  return { key: current.path, label, path: current.path, depth, children, threads, total, working, lastActivity };
}

function byActivity(a: DirNode, b: DirNode) {
  return b.working - a.working || b.lastActivity - a.lastActivity || a.label.localeCompare(b.label);
}

/** Every dir key in the tree — used to expand everything while searching. */
export function collectKeys(nodes: DirNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    out.push(node.key);
    collectKeys(node.children, out);
  }
  return out;
}

/** Keys of the nodes that lead to (and include) the dir holding a thread. */
export function keysForSession(nodes: DirNode[], sessionId: string, trail: string[] = []): string[] | null {
  for (const node of nodes) {
    const nextTrail = [...trail, node.key];
    if (node.threads.some((t) => t.id === sessionId)) return nextTrail;
    const hit = keysForSession(node.children, sessionId, nextTrail);
    if (hit) return hit;
  }
  return null;
}

/** Model label without the provider prefix: `opencode/claude-sonnet-4` -> `claude-sonnet-4`. */
export function shortModel(model: string | undefined) {
  if (!model) return "";
  const parts = model.split("/");
  return parts[parts.length - 1] ?? model;
}
