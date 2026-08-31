import { Image, Text, View } from "react-native";

// Brand marks are the real ones, shipped as bundled PNGs (assets/logo-*.png):
// Gemini's spark for agy, cline's robot, OpenAI's mark for codex, Copilot's
// visor from GitHub's own Octicons set, and
// opencode's own touch icon. Anything
// without a bundled logo falls back to an initials pill in its brand colour,
// which is what the web picker does for every provider.
const LOGOS: Record<string, any> = {
  agy: require("../assets/logo-gemini.png"),
  cline: require("../assets/logo-cline.png"),
  codex: require("../assets/logo-codex.png"),
  claude: require("../assets/logo-claude.png"),
  grok: require("../assets/logo-grok.png"),
  copilot: require("../assets/logo-copilot.png"),
  opencode: require("../assets/logo-opencode.png"),
};

type Meta = { label: string; short: string; bg: string; fg: string };

export function providerMeta(providerID: string): Meta {
  const p = (providerID || "").toLowerCase();
  // agy is the Gemini CLI — its own id says nothing, so it's named here
  if (p === "agy") return { label: "Gemini CLI", short: "Ge", bg: "#4285F4", fg: "#fff" };
  if (p === "cline") return { label: "Cline", short: "Cn", bg: "#242938", fg: "#fff" };
  if (p === "codex") return { label: "Codex", short: "Cx", bg: "#000", fg: "#fff" };
  // the CLI agent, distinct from opencode's x-ai/grok-* model provider
  if (p === "grok") return { label: "Grok CLI", short: "Gk", bg: "#000", fg: "#fff" };
  // the CLI agent, distinct from opencode's anthropic/claude-* model provider
  if (p === "claude") return { label: "Claude Code", short: "CC", bg: "#d97757", fg: "#fff" };
  // the CLI agent, distinct from opencode's own github-copilot model provider
  if (p === "copilot") return { label: "Copilot CLI", short: "Cp", bg: "#24292f", fg: "#fff" };
  if (p.includes("opencode")) return { label: "opencode", short: "OC", bg: "#7c3aed", fg: "#fff" };
  if (p.includes("openai") || p === "codex" || p.includes("open_ai")) return { label: "OpenAI", short: "OAI", bg: "#000", fg: "#fff" };
  if (p.includes("anthropic") || p.includes("claude")) return { label: "Claude", short: "Cl", bg: "#d97757", fg: "#fff" };
  if (p.includes("google") || p.includes("gemini")) return { label: "Gemini", short: "Ge", bg: "#4285F4", fg: "#fff" };
  if (p.includes("grok") || p.includes("x-ai")) return { label: "Grok", short: "Gr", bg: "#111", fg: "#fff" };
  if (p.includes("copilot")) return { label: "GitHub Copilot", short: "GH", bg: "#24292f", fg: "#fff" };
  if (p.includes("cursor")) return { label: "Cursor", short: "Cu", bg: "#000", fg: "#fff" };
  if (p.includes("deepseek")) return { label: "DeepSeek", short: "DS", bg: "#4d6bfe", fg: "#fff" };
  return { label: providerID || "unknown", short: (providerID || "?").slice(0, 2).toUpperCase(), bg: "#71717a", fg: "#fff" };
}

export default function ProviderGlyph({ providerID, size = 20 }: { providerID: string; size?: number }) {
  const logo = LOGOS[(providerID || "").toLowerCase()];
  const radius = Math.round(size * 0.28);
  if (logo) {
    return (
      <Image
        source={logo}
        style={{ width: size, height: size, borderRadius: radius }}
        resizeMode="contain"
        accessibilityIgnoresInvertColors
      />
    );
  }
  const meta = providerMeta(providerID);
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: meta.bg,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: meta.fg, fontSize: Math.round(size * 0.42), fontWeight: "700" }}>{meta.short}</Text>
    </View>
  );
}
