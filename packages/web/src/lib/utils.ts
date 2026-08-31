export function cn(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}
export function relativeTime(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "—";
  const diff = Date.now() - d;
  if (Number.isNaN(diff) || diff < 0) return "now";
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (Number.isNaN(days)) return "—";
  return `${days}d ago`;
}
