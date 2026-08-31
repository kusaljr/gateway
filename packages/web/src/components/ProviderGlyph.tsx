import logoClaude from "@/assets/logo-claude.png";
import logoCline from "@/assets/logo-cline.png";
import logoCodex from "@/assets/logo-codex.png";
import logoCopilot from "@/assets/logo-copilot.png";
import logoGemini from "@/assets/logo-gemini.png";
import logoGrok from "@/assets/logo-grok.png";
import logoOpencode from "@/assets/logo-opencode.png";

/**
 * Provider identity for the web app — the same table the mobile app uses
 * (components/ProviderGlyph.tsx there), so a thread carries the same mark on
 * both. Real brand marks rather than lucide stand-ins: the sidebar used to
 * draw a generic Cpu for opencode and a terminal glyph for everything else,
 * which made six different agents look like one.
 *
 * Anything with no bundled logo still gets an initials pill in its brand
 * colour, so an unknown provider degrades to something readable instead of a
 * broken image.
 */
const LOGOS: Record<string, string> = {
  agy: logoGemini,
  cline: logoCline,
  codex: logoCodex,
  claude: logoClaude,
  grok: logoGrok,
  copilot: logoCopilot,
  opencode: logoOpencode,
};

export type ProviderMeta = { label: string; short: string; bg: string; fg: string };

export function providerMeta(providerID: string): ProviderMeta {
  const p = (providerID || "").toLowerCase();
  // The CLI agents come first and match exactly: each one shares a name with
  // an opencode model provider (claude the agent vs anthropic/claude-* the
  // model), and the substring tests below would otherwise swallow them.
  if (p === "agy") return { label: "Gemini CLI", short: "Ge", bg: "#4285F4", fg: "#fff" };
  if (p === "cline") return { label: "Cline", short: "Cn", bg: "#242938", fg: "#fff" };
  if (p === "codex") return { label: "Codex", short: "Cx", bg: "#000", fg: "#fff" };
  if (p === "grok") return { label: "Grok CLI", short: "Gk", bg: "#000", fg: "#fff" };
  if (p === "claude") return { label: "Claude Code", short: "CC", bg: "#d97757", fg: "#fff" };
  if (p === "copilot") return { label: "Copilot CLI", short: "Cp", bg: "#24292f", fg: "#fff" };
  if (p.includes("opencode")) return { label: "opencode", short: "OC", bg: "#7c3aed", fg: "#fff" };
  if (p.includes("openai") || p.includes("open_ai")) return { label: "OpenAI", short: "OAI", bg: "#000", fg: "#fff" };
  if (p.includes("anthropic") || p.includes("claude")) return { label: "Claude", short: "Cl", bg: "#d97757", fg: "#fff" };
  if (p.includes("google") || p.includes("gemini")) return { label: "Gemini", short: "Ge", bg: "#4285F4", fg: "#fff" };
  if (p.includes("grok") || p.includes("x-ai")) return { label: "Grok", short: "Gr", bg: "#111", fg: "#fff" };
  if (p.includes("copilot")) return { label: "GitHub Copilot", short: "GH", bg: "#24292f", fg: "#fff" };
  if (p.includes("cursor")) return { label: "Cursor", short: "Cu", bg: "#000", fg: "#fff" };
  if (p.includes("deepseek")) return { label: "DeepSeek", short: "DS", bg: "#4d6bfe", fg: "#fff" };
  return { label: providerID || "unknown", short: (providerID || "?").slice(0, 2).toUpperCase(), bg: "#71717a", fg: "#fff" };
}

export function ProviderGlyph({ providerID, size = 16, className }: { providerID: string; size?: number; className?: string }) {
  const key = (providerID || "").toLowerCase();
  const logo = LOGOS[key];
  const meta = providerMeta(providerID);
  const radius = Math.round(size * 0.28);

  if (logo) {
    return (
      <img
        src={logo}
        alt=""
        aria-hidden
        width={size}
        height={size}
        title={meta.label}
        className={className}
        style={{ width: size, height: size, borderRadius: radius, objectFit: "contain", flexShrink: 0 }}
      />
    );
  }
  return (
    <span
      aria-hidden
      title={meta.label}
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: meta.bg,
        color: meta.fg,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        fontSize: Math.round(size * 0.42),
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {meta.short}
    </span>
  );
}

export default ProviderGlyph;
