import { useEffect, useState } from "react";
import { fetchDevices, type Device } from "@/lib/api";
import { Server, Globe, Circle, RefreshCw, Shield, Monitor, Cpu, Clock, Copy, ExternalLink } from "lucide-react";
import { relativeTime } from "@/lib/utils";

export function DevicesList({ onRefresh }: { onRefresh?: () => void }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const d = await fetchDevices();
    setDevices(d);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const connected = devices.filter((d) => d.status === "connected");
  const disconnected = devices.filter((d) => d.status !== "connected");

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <div className="flex items-center gap-3">
        <div className="flex size-8 items-center justify-center rounded-lg bg-orange-500/10 text-orange-600">
          <Server className="size-4" />
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-foreground">Devices connected via Cloudflare Tunnel</h1>
          <p className="text-[12px] text-muted-foreground">
            Remotely accessible from anywhere — tunnel keeps the device online without opening ports.{" "}
            <span className="inline-flex items-center gap-1 font-medium text-success-foreground">
              <span className="size-1.5 rounded-full bg-success animate-status-pulse" /> {connected.length} online
            </span>
            {devices.length > 0 && <span className="text-muted-foreground"> · {devices.length} total</span>}
          </p>
        </div>
        <button onClick={load} className="ms-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent">
          <RefreshCw className="size-3.5" /> Refresh
        </button>
      </div>

      {loading ? (
        <div className="mt-8 grid gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl border border-border bg-muted/50" />
          ))}
        </div>
      ) : devices.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-border bg-card p-8 text-center">
          <Monitor className="mx-auto size-8 text-muted-foreground/40" />
          <div className="mt-3 text-sm font-medium text-foreground">No devices connected yet</div>
          <div className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-muted-foreground">
            Run <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">kusal connect</code> on any machine with <code className="font-mono text-[11px]">cloudflared</code> installed.
            It authenticates via <code className="font-mono text-[11px]">cloudflared tunnel login</code>, creates a <code className="font-mono text-[11px]">kusal-&lt;device&gt;</code> tunnel and registers the device so it appears here for remote access.
          </div>
          <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-orange-500/10 px-3 py-1.5 text-[11px] font-medium text-orange-700">
            <Globe className="size-3.5" /> accessible via https://&lt;tunnel&gt;.cfargotunnel.com
          </div>
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          {connected.length > 0 && (
            <section>
              <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-success-foreground">
                <span className="size-1.5 rounded-full bg-success" /> Connected · remote reachable
              </div>
              <div className="grid gap-3">
                {connected.map((d) => <DeviceCard key={d.id} d={d} online />)}
              </div>
            </section>
          )}
          {disconnected.length > 0 && (
            <section>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Disconnected / last seen</div>
              <div className="grid gap-3">
                {disconnected.map((d) => <DeviceCard key={d.id} d={d} />)}
              </div>
            </section>
          )}
        </div>
      )}

      <div className="mt-8 rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-2 text-[12px] font-medium text-foreground"><Shield className="size-4 text-orange-500" /> Remote access via Cloudflare Tunnel</div>
        <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
          Each device runs <code className="font-mono text-[11px]">cloudflared tunnel run --token &lt;tunnel-token&gt;</code> forwarding to the local harness server. Cloudflare edge terminates TLS, Zero Trust Access verifies your email, and the tunnel carries shell + opencode traffic end-to-end. No inbound ports, no VPN.
        </p>
      </div>
    </div>
  );
}

function DeviceCard({ d, online }: { d: Device; online?: boolean }) {
  const shortTunnel = d.tunnel_id ? `${d.tunnel_id.slice(0, 10)}…` : "—";
  const tryCopy = (v: string) => navigator.clipboard?.writeText(v);
  const isCurrent = typeof window !== "undefined" && (d.hostname === window.location.hostname || (d.hostname.includes("localhost") && window.location.hostname === "localhost"));
  const isRemote = online && d.hostname && !isCurrent && d.hostname.includes(".");

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-3.5 shadow-sm">
      <div className={`flex size-9 shrink-0 items-center justify-center rounded-full ${online ? "bg-success/10 text-success-foreground" : "bg-muted text-muted-foreground"}`}>
        <Monitor className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{d.name || d.hostname || d.id.slice(0, 8)}</span>
          {isCurrent && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">(this device)</span>}
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${online ? "bg-success/10 text-success-foreground" : "bg-muted text-muted-foreground"}`}>
            <span className={`size-1.5 rounded-full ${online ? "bg-success animate-status-pulse" : "bg-border"}`} />{d.status}
          </span>
          {online && <Globe className="size-3 text-orange-500" />}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1"><Cpu className="size-3" />{d.hostname || "—"}</span>
          <span className="hidden h-3 w-px bg-border sm:block" />
          <span className="inline-flex items-center gap-1 font-mono text-[11px]"><Server className="size-3" />{shortTunnel}</span>
          <button onClick={() => tryCopy(d.tunnel_id)} className="rounded p-0.5 hover:bg-accent" title="Copy tunnel id"><Copy className="size-3" /></button>
          <span className="hidden h-3 w-px bg-border sm:block" />
          <span className="inline-flex items-center gap-1"><Clock className="size-3" />{relativeTime(d.last_seen)}</span>
        </div>
      </div>
      <div className="hidden shrink-0 flex-col items-end gap-1.5 sm:flex">
        {isRemote ? (
          <a
            href={`https://${d.hostname}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md bg-orange-500/10 px-2.5 py-1 text-xs font-medium text-orange-700 hover:bg-orange-500/20"
          >
            Open <ExternalLink className="size-3" />
          </a>
        ) : (
          <span className="rounded bg-orange-500/10 px-2 py-1 font-mono text-[10px] text-orange-700">{d.id.slice(0, 8)}</span>
        )}
        <span className="text-[10px] text-muted-foreground">tunnel · secure</span>
      </div>
    </div>
  );
}
