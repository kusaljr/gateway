import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  BarChart3,
  ChevronDown,
  ChevronUp,
  Clock,
  Cpu,
  DollarSign,
  Info,
  Layers,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Server,
  Zap,
} from "lucide-react";
import { fetchUsage, type Usage, type UsageDay } from "@/lib/api";
import { ProviderGlyph, providerMeta } from "@/components/ProviderGlyph";
import { estimateTokenCost, getModelRate } from "@/lib/pricing";
import { cn } from "@/lib/utils";

const WINDOWS = [
  { id: 1, label: "Today" },
  { id: 7, label: "7d" },
  { id: 14, label: "14d" },
  { id: 30, label: "30d" },
] as const;

const MODEL_PREVIEW = 5;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const TOKEN_UNITS: Array<[number, string]> = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "k"],
];

export function getTodayISO(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatTokens(n: number): string {
  if (n === 0) return "0";
  for (const [div, suffix] of TOKEN_UNITS) {
    if (n < div) continue;
    const v = n / div;
    const text = v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2);
    return `${text.replace(/\.0+$/, "")}${suffix}`;
  }
  return String(n);
}

export function formatCost(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatMetric(v: number, metric: "tokens" | "cost"): string {
  return metric === "tokens" ? formatTokens(v) : formatCost(v);
}

export function shortDate(iso?: string, markToday = false): string {
  if (!iso) return "";
  if (markToday && iso === getTodayISO()) {
    return "Today";
  }
  const [, m, d] = iso.split("-");
  const month = MONTHS[Number(m) - 1];
  return month ? `${month} ${Number(d)}` : iso;
}

export function metricValue(day: UsageDay, metric: "tokens" | "cost"): number {
  return metric === "tokens" ? day.tokens.total : day.cost;
}

export function UsageView({ onBack, onToggleLeft, leftCollapsed }: { onBack?: () => void; onToggleLeft?: () => void; leftCollapsed?: boolean }) {
  const [days, setDays] = useState<number>(14);
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [selectedDayIdx, setSelectedDayIdx] = useState<number | null>(null);
  const [hoveredDayIdx, setHoveredDayIdx] = useState<number | null>(null);
  const [allModels, setAllModels] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (windowDays: number) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchUsage(windowDays);
      setUsage(data);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to load usage data";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setSelectedDayIdx(null);
    setHoveredDayIdx(null);
    setAllModels(false);
    load(days);
  }, [days, load]);

  // Ensure every model, provider, and day has estimated cost computed if server returned 0
  const enhancedUsage = useMemo(() => {
    if (!usage) return null;

    const models = usage.models.map((m) => {
      const cost = m.cost > 0 ? m.cost : estimateTokenCost(m.provider, m.model, m.tokens);
      return { ...m, cost };
    });

    const providers = usage.providers.map((p) => {
      const providerModels = models.filter((m) => m.provider === p.provider);
      const computedCost = providerModels.reduce((acc, cur) => acc + cur.cost, 0);
      const cost = p.cost > 0 ? p.cost : (computedCost > 0 ? computedCost : estimateTokenCost(p.provider, "", p.tokens));
      return { ...p, cost, priced: true };
    });

    const daysList = usage.days.map((d) => {
      let cost = d.cost;
      if (cost === 0 && d.tokens.total > 0) {
        cost = estimateTokenCost("anthropic", "claude-sonnet-4", d.tokens);
      }
      return { ...d, cost };
    });

    const totalCost = usage.cost > 0 ? usage.cost : models.reduce((acc, m) => acc + m.cost, 0);

    return {
      ...usage,
      cost: totalCost,
      models,
      providers,
      days: daysList,
    };
  }, [usage]);

  const activeDayIdx = hoveredDayIdx ?? selectedDayIdx;
  const activeDay = enhancedUsage && activeDayIdx !== null ? enhancedUsage.days[activeDayIdx] : null;

  const tableDays = useMemo(() => (enhancedUsage ? [...enhancedUsage.days].reverse() : []), [enhancedUsage]);
  const models = enhancedUsage?.models ?? [];
  const shownModels = allModels ? models : models.slice(0, MODEL_PREVIEW);

  const values = useMemo(() => (enhancedUsage ? enhancedUsage.days.map((d) => metricValue(d, metric)) : []), [enhancedUsage, metric]);
  const maxMetric = useMemo(() => (values.length > 0 ? Math.max(...values, 0) : 0), [values]);
  const peakIdx = useMemo(() => (maxMetric > 0 ? values.indexOf(maxMetric) : -1), [values, maxMetric]);

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-background">
      {/* Top Header */}
      <div className="sticky top-0 z-20 flex h-[52px] shrink-0 items-center justify-between border-b border-border bg-card/90 px-4 backdrop-blur-md">
        <div className="flex items-center gap-2.5">
          {onToggleLeft && (
            <button
              onClick={onToggleLeft}
              title={leftCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="rounded-control p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {leftCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
            </button>
          )}
          {onBack && (
            <button
              onClick={onBack}
              className="inline-flex items-center gap-1 rounded-control p-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="Back to chat"
            >
              <ArrowLeft className="size-4" />
            </button>
          )}
          <div className="flex size-7 items-center justify-center rounded-lg bg-orange-500/10 text-orange-600">
            <BarChart3 className="size-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold tracking-tight text-foreground">Usage Telemetry</span>
              {enhancedUsage?.hostname && (
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                  {enhancedUsage.hostname}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Time range pills */}
          <div className="flex rounded-control bg-muted p-0.5">
            {WINDOWS.map((w) => (
              <button
                key={w.id}
                onClick={() => setDays(w.id)}
                className={cn(
                  "rounded-[0.375rem] px-2.5 py-1 text-xs font-medium transition-colors",
                  days === w.id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {w.label}
              </button>
            ))}
          </div>

          <button
            onClick={() => load(days)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-control border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            title="Refresh usage telemetry"
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin text-orange-600")} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      <div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6 lg:p-8">
        {/* Error notice */}
        {error && (
          <div className="flex items-center gap-3 rounded-xl border border-error/30 bg-error/10 p-4 text-sm text-error-foreground">
            <AlertCircle className="size-5 shrink-0 text-error" />
            <div className="min-w-0 flex-1">{error}</div>
            <button
              onClick={() => load(days)}
              className="rounded-control bg-error/20 px-2.5 py-1 text-xs font-medium hover:bg-error/30"
            >
              Retry
            </button>
          </div>
        )}

        {/* Loading State */}
        {loading && !enhancedUsage && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-24 animate-pulse rounded-2xl border border-border bg-card/60 p-4" />
              ))}
            </div>
            <div className="h-64 animate-pulse rounded-2xl border border-border bg-card/60" />
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <div className="h-48 animate-pulse rounded-2xl border border-border bg-card/60" />
              <div className="h-48 animate-pulse rounded-2xl border border-border bg-card/60" />
            </div>
          </div>
        )}

        {/* Data Loaded */}
        {enhancedUsage && (
          <>
            {/* Header timeframe subtitle */}
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5 font-mono">
                <Clock className="size-3.5" />
                <span>
                  {days === 1
                    ? `Today (${shortDate(enhancedUsage.to)})`
                    : `${enhancedUsage.from} → ${enhancedUsage.to}`}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span>{enhancedUsage.sessions_scanned} sessions scanned</span>
                <span>•</span>
                <span>{enhancedUsage.days.length} {enhancedUsage.days.length === 1 ? "day" : "days"} recorded</span>
              </div>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
              <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
                <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <span>Total Tokens</span>
                  <Zap className="size-3.5 text-orange-500" />
                </div>
                <div className="mt-2 font-mono text-2xl font-bold tracking-tight text-foreground">
                  {formatTokens(enhancedUsage.tokens.total)}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {enhancedUsage.messages.toLocaleString()} turns metered
                </div>
              </div>

              <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
                <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <span>Estimated Cost</span>
                  <DollarSign className="size-3.5 text-emerald-500" />
                </div>
                <div className="mt-2 font-mono text-2xl font-bold tracking-tight text-foreground">
                  {formatCost(enhancedUsage.cost)}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  calculated from model API rates
                </div>
              </div>

              <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
                <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <span>Total Turns</span>
                  <MessageSquare className="size-3.5 text-blue-500" />
                </div>
                <div className="mt-2 font-mono text-2xl font-bold tracking-tight text-foreground">
                  {enhancedUsage.messages.toLocaleString()}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  opencode & CLI agents
                </div>
              </div>

              <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
                <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <span>Active Models</span>
                  <Cpu className="size-3.5 text-purple-500" />
                </div>
                <div className="mt-2 font-mono text-2xl font-bold tracking-tight text-foreground">
                  {models.length}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  across {enhancedUsage.providers.length} providers
                </div>
              </div>
            </div>

            {/* Interactive Daily Chart */}
            <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">Daily Activity</span>
                  <span className="text-xs text-muted-foreground">
                    Peak: {maxMetric > 0 ? formatMetric(maxMetric, metric) : "—"}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex rounded-control bg-muted p-0.5">
                    <button
                      onClick={() => setMetric("tokens")}
                      className={cn(
                        "rounded-[0.375rem] px-2.5 py-1 text-xs font-medium transition-colors",
                        metric === "tokens"
                          ? "bg-card text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      Tokens
                    </button>
                    <button
                      onClick={() => setMetric("cost")}
                      className={cn(
                        "rounded-[0.375rem] px-2.5 py-1 text-xs font-medium transition-colors",
                        metric === "cost"
                          ? "bg-card text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      Cost ($)
                    </button>
                  </div>
                </div>
              </div>

              {/* Chart container */}
              <div className="mt-4">
                <div className="flex h-44 items-end gap-1.5 border-b border-border sm:gap-2">
                  {enhancedUsage.days.map((d, i) => {
                    const v = values[i];
                    const ratio = maxMetric > 0 ? v / maxMetric : 0;
                    const barHeight = v > 0 ? Math.max(8, Math.round(ratio * 136)) : 3;
                    const isSelected = selectedDayIdx === i;
                    const isHovered = hoveredDayIdx === i;
                    const isPeak = i === peakIdx && v > 0;
                    const isHighlighted = isSelected || isHovered;

                    return (
                      <div
                        key={d.date}
                        className="group relative flex flex-1 flex-col items-center justify-end h-full cursor-pointer"
                        onMouseEnter={() => setHoveredDayIdx(i)}
                        onMouseLeave={() => setHoveredDayIdx(null)}
                        onClick={() => setSelectedDayIdx((cur) => (cur === i ? null : i))}
                      >
                        {/* Peak or highlighted badge */}
                        {(isHighlighted || (isPeak && !activeDay)) && (
                          <div className="absolute -top-7 z-10 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 font-mono text-[10px] font-medium text-background shadow transition-transform">
                            {formatMetric(v, metric)}
                          </div>
                        )}

                        {/* Bar element */}
                        <div
                          style={{ height: barHeight }}
                          className={cn(
                            "w-full rounded-t transition-all duration-150",
                            v > 0
                              ? isHighlighted
                                ? "bg-orange-600 ring-2 ring-orange-400"
                                : "bg-orange-500 hover:bg-orange-600"
                              : "bg-muted hover:bg-border",
                          )}
                        />
                      </div>
                    );
                  })}
                </div>

                {/* X Axis labels */}
                <div className="mt-2 flex justify-between font-mono text-[10px] text-muted-foreground">
                  {days === 1 ? (
                    <span className="w-full text-center font-semibold text-foreground">
                      Today ({shortDate(enhancedUsage.days[0]?.date)})
                    </span>
                  ) : (
                    [0, Math.floor((enhancedUsage.days.length - 1) / 2), enhancedUsage.days.length - 1]
                      .filter((idx, pos, arr) => idx >= 0 && arr.indexOf(idx) === pos)
                      .map((idx) => {
                        const isLast = idx === enhancedUsage.days.length - 1;
                        const isToday = isLast && enhancedUsage.days[idx]?.date === getTodayISO();
                        return (
                          <span key={idx} className={isToday ? "font-semibold text-foreground" : undefined}>
                            {isToday ? "Today" : shortDate(enhancedUsage.days[idx]?.date)}
                          </span>
                        );
                      })
                  )}
                </div>
              </div>

              {/* Selected/Hovered Day Detail Callout */}
              <div className="mt-4 rounded-xl border border-border/80 bg-muted/40 p-3 text-xs">
                {activeDay ? (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <span className="font-semibold text-foreground">{shortDate(activeDay.date)}</span>
                      <span className="ms-2 font-mono text-muted-foreground">{activeDay.date}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-4 font-mono">
                      <span>
                        <strong className="text-foreground">{formatTokens(activeDay.tokens.total)}</strong> tokens
                      </span>
                      <span>
                        <strong className="text-foreground">{formatCost(activeDay.cost)}</strong> estimated cost
                      </span>
                      <span>
                        <strong className="text-foreground">{activeDay.messages}</strong> turns
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Click or hover over any bar to inspect day details</span>
                    <span className="font-mono">
                      Window total: {formatTokens(enhancedUsage.tokens.total)} · {formatCost(enhancedUsage.cost)}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Two Column Grid: Token Mix & Providers */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {/* Token Mix Distribution */}
              <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
                <div className="flex items-center gap-2 border-b border-border pb-3">
                  <Layers className="size-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold text-foreground">Token Mix Distribution</h2>
                </div>

                <div className="mt-4 space-y-3.5">
                  <MixRow label="Input (Fresh)" value={enhancedUsage.tokens.input} total={enhancedUsage.tokens.total} />
                  <MixRow label="Output" value={enhancedUsage.tokens.output} total={enhancedUsage.tokens.total} />
                  <MixRow label="Reasoning / Thinking" value={enhancedUsage.tokens.reasoning} total={enhancedUsage.tokens.total} />
                  <MixRow label="Cache Read" value={enhancedUsage.tokens.cache_read} total={enhancedUsage.tokens.total} />
                  <MixRow label="Cache Write" value={enhancedUsage.tokens.cache_write} total={enhancedUsage.tokens.total} />
                </div>

                <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground border-t border-border/60 pt-3">
                  Prompt caching (e.g. Claude & Gemini cache reads at ~10% input cost) significantly reduces actual API token spend.
                </p>
              </div>

              {/* By Provider */}
              <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
                <div className="flex items-center gap-2 border-b border-border pb-3">
                  <Server className="size-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold text-foreground">Usage by Provider</h2>
                  <span className="ms-auto font-mono text-xs text-muted-foreground">{enhancedUsage.providers.length}</span>
                </div>

                <div className="mt-4 divide-y divide-border/60">
                  {enhancedUsage.providers.length === 0 ? (
                    <div className="py-6 text-center text-xs text-muted-foreground">No provider data in this window</div>
                  ) : (
                    enhancedUsage.providers.map((p) => {
                      const pct = enhancedUsage.tokens.total > 0 ? (p.tokens.total / enhancedUsage.tokens.total) * 100 : 0;
                      return (
                        <div key={p.provider} className="py-3 first:pt-0 last:pb-0">
                          <div className="flex items-center gap-2.5">
                            <ProviderGlyph providerID={p.provider} size={18} />
                            <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                              {providerMeta(p.provider).label}
                            </span>
                            <span className="font-mono text-xs font-semibold text-foreground">
                              {formatTokens(p.tokens.total)}
                            </span>
                            <span className="w-16 text-right font-mono text-xs text-muted-foreground">
                              {formatCost(p.cost)}
                            </span>
                          </div>

                          {/* Progress bar */}
                          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-orange-500 transition-all duration-300"
                              style={{ width: `${Math.max(pct > 0 ? 3 : 0, pct)}%` }}
                            />
                          </div>

                          <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
                            <span>
                              {p.messages} turns • {p.models} {p.models === 1 ? "model" : "models"}
                            </span>
                            <span className="font-mono">{pct.toFixed(1)}%</span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            {/* Usage by Model */}
            <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
              <div className="flex items-center justify-between border-b border-border pb-3">
                <div className="flex items-center gap-2">
                  <Cpu className="size-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold text-foreground">Usage & Rates by Model</h2>
                </div>
                <span className="font-mono text-xs text-muted-foreground">{models.length} models</span>
              </div>

              <div className="mt-4 divide-y divide-border/60">
                {models.length === 0 ? (
                  <div className="py-6 text-center text-xs text-muted-foreground">No model data recorded</div>
                ) : (
                  <>
                    {shownModels.map((m) => {
                      const pct = enhancedUsage.tokens.total > 0 ? (m.tokens.total / enhancedUsage.tokens.total) * 100 : 0;
                      const rate = getModelRate(m.provider, m.model);
                      return (
                        <div key={m.key} className="py-3 first:pt-0 last:pb-0">
                          <div className="flex items-center gap-2.5">
                            <ProviderGlyph providerID={m.provider} size={18} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-xs font-medium text-foreground">{m.model}</span>
                                {rate.label && (
                                  <span className="rounded bg-muted px-1.5 py-0.2 font-mono text-[10px] text-muted-foreground hidden sm:inline">
                                    {rate.label}
                                  </span>
                                )}
                              </div>
                              <span className="text-[10px] text-muted-foreground">
                                {providerMeta(m.provider).label}
                              </span>
                            </div>
                            <span className="font-mono text-xs font-semibold text-foreground">
                              {formatTokens(m.tokens.total)}
                            </span>
                            <span className="w-16 text-right font-mono text-xs font-semibold text-emerald-600">
                              {formatCost(m.cost)}
                            </span>
                          </div>

                          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-orange-500 transition-all duration-300"
                              style={{ width: `${Math.max(pct > 0 ? 3 : 0, pct)}%` }}
                            />
                          </div>

                          <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
                            <span>{m.messages} {m.messages === 1 ? "turn" : "turns"}</span>
                            <span className="font-mono">{pct.toFixed(1)}%</span>
                          </div>
                        </div>
                      );
                    })}

                    {models.length > MODEL_PREVIEW && (
                      <div className="pt-3 text-center">
                        <button
                          onClick={() => setAllModels((v) => !v)}
                          className="inline-flex items-center gap-1.5 rounded-control px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        >
                          {allModels ? (
                            <>
                              <ChevronUp className="size-3.5" /> Show fewer
                            </>
                          ) : (
                            <>
                              <ChevronDown className="size-3.5" /> Show all {models.length} models
                            </>
                          )}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Daily Table */}
            <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
              <div className="flex items-center justify-between border-b border-border pb-3">
                <h2 className="text-sm font-semibold text-foreground">Daily History</h2>
                <span className="text-xs text-muted-foreground">Newest first</span>
              </div>

              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      <th className="py-2.5 pe-4">Date</th>
                      <th className="py-2.5 px-4 text-right">Turns</th>
                      <th className="py-2.5 px-4 text-right">Tokens</th>
                      <th className="py-2.5 ps-4 text-right">Estimated Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {tableDays.map((d) => {
                      const isToday = d.date === getTodayISO();
                      return (
                        <tr key={d.date} className={cn("transition-colors hover:bg-muted/30", isToday && "bg-orange-500/[0.03]")}>
                          <td className="py-2.5 pe-4 font-medium text-foreground">
                            <div className="flex items-center gap-1.5">
                              <span>{shortDate(d.date)}</span>
                              {isToday && (
                                <span className="rounded-full bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-orange-600">
                                  Today
                                </span>
                              )}
                              <span className="font-mono text-[10px] text-muted-foreground">({d.date})</span>
                            </div>
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono text-muted-foreground">
                            {d.messages ? d.messages.toLocaleString() : "—"}
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono font-medium text-foreground">
                            {d.tokens.total ? d.tokens.total.toLocaleString() : "—"}
                          </td>
                          <td className="py-2.5 ps-4 text-right font-mono text-foreground font-medium">
                            {d.cost ? formatCost(d.cost) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-border font-semibold text-foreground">
                      <td className="py-3 pe-4">Total ({days === 1 ? "Today" : `${days}d`})</td>
                      <td className="py-3 px-4 text-right font-mono">{enhancedUsage.messages.toLocaleString()}</td>
                      <td className="py-3 px-4 text-right font-mono">{enhancedUsage.tokens.total.toLocaleString()}</td>
                      <td className="py-3 ps-4 text-right font-mono font-bold text-emerald-600">{formatCost(enhancedUsage.cost)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* Unmetered providers and Pricing Reference Notes */}
            <div className="rounded-2xl border border-border bg-muted/30 p-5 text-xs text-muted-foreground space-y-3">
              <div className="flex items-start gap-2">
                <Info className="size-4 shrink-0 text-muted-foreground mt-0.5" />
                <div className="space-y-1">
                  <div className="font-semibold text-foreground">API Pricing Estimation Methodology</div>
                  <p>
                    Estimated costs are calculated directly from metered token history using official standard API pricing rates (e.g. Claude Sonnet at $3.00/1M input & $15.00/1M output, Claude Haiku at $0.80/$4.00, GPT-4o at $2.50/$10.00, Gemini Pro at $1.25/$5.00, Gemini Flash at $0.075/$0.30), factoring in discounted prompt cache hits and reasoning tokens.
                  </p>
                </div>
              </div>

              {enhancedUsage.unmetered && enhancedUsage.unmetered.length > 0 && (
                <div className="border-t border-border/50 pt-3">
                  <div className="font-semibold text-foreground mb-1.5">Unmetered CLIs:</div>
                  <div className="space-y-1.5">
                    {enhancedUsage.unmetered.map((u) => (
                      <div key={u.provider} className="flex items-center gap-2">
                        <ProviderGlyph providerID={u.provider} size={14} />
                        <span className="font-medium text-foreground">{providerMeta(u.provider).label}:</span>
                        <span>{u.reason}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {enhancedUsage.opencode_error && (
                <p className="text-warning-foreground border-t border-border/50 pt-2">
                  opencode daemon was unreachable ({enhancedUsage.opencode_error}), but CLI agent counts were collected from local history.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MixRow({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <div className="flex items-center gap-2">
          <span className="font-mono font-medium text-foreground">{formatTokens(value)}</span>
          <span className="w-12 text-right font-mono text-[11px] text-muted-foreground">({pct.toFixed(0)}%)</span>
        </div>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary/80 transition-all duration-300"
          style={{ width: `${Math.max(pct > 0 ? 2 : 0, pct)}%` }}
        />
      </div>
    </div>
  );
}
