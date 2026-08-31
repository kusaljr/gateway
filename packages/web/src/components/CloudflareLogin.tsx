import { useState } from "react";
import { Globe, Lock, Shield, Server, ArrowRight, Mail, Check } from "lucide-react";
import { loginWithCloudflare } from "@/lib/auth";

export function CloudflareLogin({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes("@")) { setErr("Enter your Cloudflare Access email"); return; }
    setBusy(true); setErr(null);
    try {
      await loginWithCloudflare(trimmed);
      onSuccess();
    } catch (e: any) { setErr(e.message || "Login failed"); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-[420px]">
        <div className="rounded-[20px] border border-border bg-card p-7 shadow-xl shadow-black/[0.06]">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-xl bg-orange-500 text-white shadow-sm">
              <Shield className="size-5" />
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-widest text-orange-600">Cloudflare Tunnel</div>
              <div className="text-sm font-semibold leading-none text-foreground">kusal · remote access</div>
            </div>
            <span className="ms-auto hidden items-center gap-1.5 rounded-full bg-orange-500/10 px-2.5 py-1 text-[11px] font-medium text-orange-700 sm:flex">
              <Globe className="size-3" /> anywhere in the world
            </span>
          </div>

          <h1 className="mt-6 text-[22px] font-semibold tracking-tight text-foreground">Login with Cloudflare</h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
            This device is exposed securely via <span className="font-medium text-foreground">Cloudflare Tunnel</span> + <span className="font-medium text-foreground">Zero Trust Access</span>.
            Authenticate with your Cloudflare Access identity to see connected devices and open a remote session.
          </p>

          <form onSubmit={submit} className="mt-6 space-y-3">
            <label className="block">
              <span className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-foreground">
                <Mail className="size-3.5 text-muted-foreground" /> Cloudflare Access email
              </span>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@yourteam.cloudflareaccess.com"
                type="email"
                autoComplete="email"
                className="w-full rounded-xl border border-border bg-background px-3.5 py-2.5 text-[13px] outline-none placeholder:text-muted-foreground/60 focus:border-orange-500/50 focus:ring-4 focus:ring-orange-500/10"
                disabled={busy}
              />
            </label>

            {err && <div className="rounded-lg border border-error/20 bg-error/5 px-3 py-2 text-[12px] text-error-foreground">{err}</div>}

            <button
              type="submit"
              disabled={busy}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-orange-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-orange-600 disabled:opacity-60"
            >
              {busy ? "Authenticating…" : "Continue with Cloudflare"}
              <ArrowRight className="size-4" />
            </button>

            <div className="flex items-center gap-2 py-1">
              <span className="h-px flex-1 bg-border" />
              <span className="text-[11px] text-muted-foreground">or</span>
              <span className="h-px flex-1 bg-border" />
            </div>

            <a
              href="https://one.dash.cloudflare.com/"
              target="_blank"
              rel="noreferrer"
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground hover:bg-accent"
            >
              <Server className="size-4 text-muted-foreground" /> Open Cloudflare Zero Trust dashboard
            </a>
          </form>

          <div className="mt-6 rounded-xl bg-muted p-3.5">
            <div className="flex items-center gap-2 text-[12px] font-medium text-foreground">
              <Lock className="size-3.5 text-muted-foreground" /> How it works
            </div>
            <ol className="mt-2 list-decimal space-y-1 ps-5 text-[12px] leading-relaxed text-muted-foreground">
              <li>Device runs <code className="rounded bg-card px-1 py-0.5 font-mono text-[11px]">kusal connect</code> → creates <code className="font-mono text-[11px]">kusal-&lt;device&gt;</code> tunnel via <code className="font-mono text-[11px]">cloudflared</code></li>
              <li>Cloudflare edge forwards <code className="font-mono text-[11px]">https://&lt;tunnel&gt;.cfargotunnel.com</code> to the local shell server</li>
              <li>Zero Trust Access verifies your email before this login succeeds</li>
            </ol>
          </div>

          <p className="mt-4 text-center text-[11px] text-muted-foreground">
            Demo mode: any valid email is accepted locally. Behind a real tunnel + Access, the <code className="font-mono">Cf-Access-*</code> header authenticates automatically.
          </p>
        </div>

        <p className="mt-4 text-center text-[11px] text-muted-foreground">
          Protected by Cloudflare · Encrypted tunnel · No ports opened
        </p>
      </div>
    </div>
  );
}
