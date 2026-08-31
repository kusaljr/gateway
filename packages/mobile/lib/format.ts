export function relativeTime(iso: string) {
  if (!iso) return "—";
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "—";
  const diff = Date.now() - d;
  if (diff < 60000) return "now";
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// "up since" is not "last seen": relativeTime turns a timestamp into how long
// ago it happened, which is the right sentence for a device that went away and
// the wrong one for a tunnel that has been connected ever since. This counts
// forward from the same instant instead — 3d 4h of continuous uptime.
export function uptime(iso: string) {
  if (!iso) return "—";
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "—";
  const s = Math.max(0, Date.now() - d);
  const m = Math.floor(s / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const days = Math.floor(h / 24);
  return `${days}d ${h % 24}h`;
}

// The exact moment, for the rows where "2d ago" is not enough — when a tunnel
// was created, when it last dropped. Local time, since the reader is standing
// next to the machine as often as not.
export function absoluteTime(iso: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}, ${d.toLocaleTimeString(
    undefined,
    { hour: "2-digit", minute: "2-digit" }
  )}`;
}
