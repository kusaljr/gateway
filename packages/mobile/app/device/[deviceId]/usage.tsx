import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import ProviderGlyph, { providerMeta } from "../../../components/ProviderGlyph";
import Splash from "../../../components/Splash";
import UsageChart, { formatCost, formatMetric, formatTokens, shortDate, type UsageMetric } from "../../../components/UsageChart";
import { MONO_FONT } from "../../../lib/fonts";
import { useSession } from "../../../lib/session";
import { fetchUsage, type Usage } from "../../../lib/api";

const WINDOWS = [1, 7, 14, 30];
// A busy machine easily runs a dozen models in a fortnight — show the ones that
// actually moved the number and keep the rest one tap away.
const MODEL_PREVIEW = 5;

export default function UsageScreen() {
  const { deviceId } = useLocalSearchParams<{ deviceId: string }>();
  const { ready, user, tunnelUrl, auth, deviceById } = useSession();
  const [days, setDays] = useState(14);
  const [metric, setMetric] = useState<UsageMetric>("tokens");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [allModels, setAllModels] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!tunnelUrl || !auth.token) return;
    try {
      const res = await fetchUsage(tunnelUrl, auth, days);
      setUsage(res);
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ? String(e.message).slice(0, 240) : "Could not read usage");
    }
  }, [tunnelUrl, auth, days]);

  useEffect(() => {
    setUsage(null);
    setSelected(null);
    setAllModels(false);
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // newest first in the table; the chart keeps chronological order
  const tableDays = useMemo(() => (usage ? [...usage.days].reverse() : []), [usage]);

  if (!ready) return <Splash />;
  if (!user) return <Redirect href="/login" />;

  const device = deviceById(deviceId);
  const deviceLabel = device?.name || device?.hostname || deviceId.slice(0, 8);
  const day = usage && selected !== null ? usage.days[selected] : null;
  // an older daemon answers without these fields; treat missing as "nothing to
  // report" rather than letting the screen crash on them
  const unmetered = usage?.unmetered ?? [];
  const models = usage?.models ?? [];
  const shownModels = allModels ? models : models.slice(0, MODEL_PREVIEW);
  // a model has no `priced` flag of its own — it inherits its provider's, so a
  // CLI model prints "—" rather than a $0.00 that would read as "free"
  const unpricedProviders = new Set(
    (usage?.providers ?? []).filter((p) => p.priced === false).map((p) => p.provider)
  );

  return (
    <SafeAreaView className="flex-1 bg-zinc-50">
      <View className="flex-row items-center justify-between border-b border-zinc-200 bg-white px-4 py-3">
        <Pressable onPress={() => router.back()}>
          <Text className="text-sm text-zinc-600">← Back</Text>
        </Pressable>
        <Text className="flex-1 px-2 text-center text-sm font-semibold text-zinc-900" numberOfLines={1}>Usage</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 18, paddingBottom: 36 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#f97316" colors={["#f97316"]} />}
      >
        <View className="mx-auto w-full max-w-md">
          <Text className="text-xl font-bold text-zinc-900" numberOfLines={1}>{deviceLabel}</Text>
          <Text style={{ fontFamily: MONO_FONT }} className="mt-1 text-[11px] text-zinc-400" numberOfLines={1}>
            {usage ? (days === 1 ? `Today (${usage.to})` : `${usage.from} → ${usage.to}`) : "—"}
          </Text>

          <View className="mt-3 flex-row gap-1.5">
            {WINDOWS.map((w) => (
              <Pressable
                key={w}
                onPress={() => setDays(w)}
                className={`rounded-full border px-3 py-1 ${days === w ? "border-zinc-900 bg-zinc-900" : "border-zinc-200 bg-white"}`}
              >
                <Text className={`text-[11px] font-medium ${days === w ? "text-white" : "text-zinc-600"}`}>{w === 1 ? "Today" : `${w}d`}</Text>
              </Pressable>
            ))}
          </View>

          {err ? (
            <View className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5">
              <Text className="text-xs leading-4 text-red-700">{err}</Text>
            </View>
          ) : !usage ? (
            <ChartSkeleton />
          ) : (
            <>
              <View className="mt-4 flex-row gap-2.5">
                <Tile label="Tokens" value={formatTokens(usage.tokens.total)} sub={`${usage.messages} turns`} />
                <Tile
                  label="Cost"
                  value={formatCost(usage.cost)}
                  sub={usage.unpriced_messages ? `${usage.unpriced_messages} unpriced` : "all turns priced"}
                />
              </View>

              <View className="mt-4 rounded-2xl border border-zinc-200 bg-white px-4 pb-3.5 pt-3">
                {/* One measure at a time: tokens and dollars share no scale. */}
                <View className="mb-3 flex-row items-center justify-between">
                  <View className="flex-row gap-1.5">
                    <Toggle label="Tokens" active={metric === "tokens"} onPress={() => setMetric("tokens")} />
                    <Toggle label="Cost" active={metric === "cost"} onPress={() => setMetric("cost")} />
                  </View>
                  <Text className="text-[10px] text-zinc-400">tap a bar</Text>
                </View>

                <UsageChart days={usage.days} metric={metric} selected={selected} onSelect={setSelected} />

                <View className="mt-3 border-t border-zinc-100 pt-2.5">
                  {day ? (
                    <Text className="text-[11px] text-zinc-600">
                      <Text className="font-semibold text-zinc-900">{shortDate(day.date)}</Text>
                      {`  ${formatTokens(day.tokens.total)} tokens · ${formatCost(day.cost)} · ${day.messages} turns`}
                    </Text>
                  ) : (
                    <Text className="text-[11px] text-zinc-400">
                      {`Peak day ${formatMetric(Math.max(...usage.days.map((d) => (metric === "tokens" ? d.tokens.total : d.cost))), metric)} · window total ${metric === "tokens" ? formatTokens(usage.tokens.total) : formatCost(usage.cost)}`}
                    </Text>
                  )}
                </View>
              </View>

              <SectionLabel>By provider</SectionLabel>
              <View className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
                {usage.providers.length === 0 ? (
                  <Empty text="Nothing metered in this window" />
                ) : (
                  usage.providers.map((p, i) => (
                    <View key={p.provider} className={i === 0 ? undefined : "border-t border-zinc-100"}>
                      <View className="px-4 py-3">
                        <View className="flex-row items-center gap-3">
                          <ProviderGlyph providerID={p.provider} size={20} />
                          <Text className="flex-1 text-[13px] font-medium text-zinc-900" numberOfLines={1}>
                            {providerMeta(p.provider).label}
                          </Text>
                          <Text style={{ fontFamily: MONO_FONT }} className="text-[12px] text-zinc-900" numberOfLines={1}>
                            {formatTokens(p.tokens.total)}
                          </Text>
                          {/* a CLI on your own subscription writes no price,
                              so a "$0.00" there would read as "free" */}
                          <Text
                            style={{ fontFamily: MONO_FONT }}
                            className="w-[64px] text-right text-[12px] text-zinc-500"
                            numberOfLines={1}
                          >
                            {p.priced !== false ? formatCost(p.cost) : "—"}
                          </Text>
                        </View>
                        {/* share of the window's tokens — magnitude, one hue */}
                        <View className="mt-2 h-1 overflow-hidden rounded-full bg-zinc-100">
                          <View
                            className="h-1 rounded-full bg-orange-500"
                            style={{ width: `${usage.tokens.total > 0 ? Math.max(2, (p.tokens.total / usage.tokens.total) * 100) : 0}%` }}
                          />
                        </View>
                        <Text className="mt-1.5 text-[10px] text-zinc-400" numberOfLines={1}>
                          {`${p.messages} turns · ${p.models} ${p.models === 1 ? "model" : "models"}${p.priced !== false ? "" : " · no price reported"}`}
                        </Text>
                      </View>
                    </View>
                  ))
                )}
              </View>

              <SectionLabel>By model</SectionLabel>
              <View className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
                {models.length === 0 ? (
                  <Empty text="Nothing metered in this window" />
                ) : (
                  <>
                    {shownModels.map((m, i) => (
                      <View key={m.key} className={i === 0 ? undefined : "border-t border-zinc-100"}>
                        <View className="px-4 py-3">
                          <View className="flex-row items-center gap-3">
                            <ProviderGlyph providerID={m.provider} size={20} />
                            <Text className="flex-1 text-[13px] font-medium text-zinc-900" numberOfLines={1}>
                              {m.model}
                            </Text>
                            <Text style={{ fontFamily: MONO_FONT }} className="text-[12px] text-zinc-900" numberOfLines={1}>
                              {formatTokens(m.tokens.total)}
                            </Text>
                            <Text
                              style={{ fontFamily: MONO_FONT }}
                              className="w-[64px] text-right text-[12px] text-zinc-500"
                              numberOfLines={1}
                            >
                              {unpricedProviders.has(m.provider) ? "—" : formatCost(m.cost)}
                            </Text>
                          </View>
                          <View className="mt-2 h-1 overflow-hidden rounded-full bg-zinc-100">
                            <View
                              className="h-1 rounded-full bg-orange-500"
                              style={{ width: `${usage.tokens.total > 0 ? Math.max(2, (m.tokens.total / usage.tokens.total) * 100) : 0}%` }}
                            />
                          </View>
                          <Text className="mt-1.5 text-[10px] text-zinc-400" numberOfLines={1}>
                            {`${providerMeta(m.provider).label} · ${m.messages} ${m.messages === 1 ? "turn" : "turns"}`}
                          </Text>
                        </View>
                      </View>
                    ))}
                    {models.length > MODEL_PREVIEW ? (
                      <Pressable
                        onPress={() => setAllModels((v) => !v)}
                        className="border-t border-zinc-100 bg-zinc-50 px-4 py-2.5 active:bg-zinc-100"
                      >
                        <Text className="text-center text-[11px] font-medium text-zinc-600">
                          {allModels ? "Show fewer" : `Show all ${models.length} models`}
                        </Text>
                      </Pressable>
                    ) : null}
                  </>
                )}
              </View>

              <SectionLabel>By day</SectionLabel>
              <View className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
                {/* Fixed number columns, wide enough for the largest value the
                    exact view can print: a full 10-digit token count with
                    separators at mono 11.5px. The date column absorbs the rest. */}
                <View className="flex-row items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-4 py-2">
                  <Text className="flex-1 text-[10px] font-semibold uppercase text-zinc-400">Date</Text>
                  <Text className="w-[94px] text-right text-[10px] font-semibold uppercase text-zinc-400">Tokens</Text>
                  <Text className="w-[64px] text-right text-[10px] font-semibold uppercase text-zinc-400">Cost</Text>
                </View>
                {tableDays.map((d, i) => (
                  <View
                    key={d.date}
                    className={`flex-row items-center gap-2 px-4 py-2.5 ${i === 0 ? "" : "border-t border-zinc-100"}`}
                  >
                    <Text
                      className={`flex-1 text-[12px] ${d.messages ? "text-zinc-900" : "text-zinc-400"}`}
                      numberOfLines={1}
                    >
                      {shortDate(d.date)}
                    </Text>
                    <Text
                      style={{ fontFamily: MONO_FONT, fontSize: 11.5 }}
                      className={`w-[94px] text-right ${d.messages ? "text-zinc-900" : "text-zinc-300"}`}
                      numberOfLines={1}
                    >
                      {d.tokens.total ? d.tokens.total.toLocaleString() : "—"}
                    </Text>
                    <Text
                      style={{ fontFamily: MONO_FONT, fontSize: 11.5 }}
                      className={`w-[64px] text-right ${d.cost ? "text-zinc-900" : "text-zinc-300"}`}
                      numberOfLines={1}
                    >
                      {d.cost ? formatCost(d.cost) : "—"}
                    </Text>
                  </View>
                ))}
                <View className="flex-row items-center gap-2 border-t border-zinc-200 bg-zinc-50 px-4 py-2.5">
                  <Text className="flex-1 text-[12px] font-semibold text-zinc-900" numberOfLines={1}>Total</Text>
                  <Text
                    style={{ fontFamily: MONO_FONT, fontSize: 11.5 }}
                    className="w-[94px] text-right font-semibold text-zinc-900"
                    numberOfLines={1}
                  >
                    {usage.tokens.total.toLocaleString()}
                  </Text>
                  <Text
                    style={{ fontFamily: MONO_FONT, fontSize: 11.5 }}
                    className="w-[64px] text-right font-semibold text-zinc-900"
                    numberOfLines={1}
                  >
                    {formatCost(usage.cost)}
                  </Text>
                </View>
              </View>

              <SectionLabel>Token mix</SectionLabel>
              <View className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
                <MixRow label="Input" value={usage.tokens.input} total={usage.tokens.total} first />
                <MixRow label="Output" value={usage.tokens.output} total={usage.tokens.total} />
                <MixRow label="Reasoning" value={usage.tokens.reasoning} total={usage.tokens.total} />
                <MixRow label="Cache read" value={usage.tokens.cache_read} total={usage.tokens.total} />
                <MixRow label="Cache write" value={usage.tokens.cache_write} total={usage.tokens.total} />
              </View>

              {usage.unpriced_messages > 0 ? (
                <Note>
                  {`${usage.unpriced_messages} of ${usage.messages} turns carry no price: agent CLIs bill through your own subscription, and opencode prices a free model at $0. The dollar column covers only the turns that reported one.`}
                </Note>
              ) : null}
              {unmetered.length > 0 ? (
                <>
                  <SectionLabel>Not counted</SectionLabel>
                  <View className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
                    {unmetered.map((u, i) => (
                      <View
                        key={u.provider}
                        className={`flex-row items-center gap-3 px-4 py-3 ${i === 0 ? "" : "border-t border-zinc-100"}`}
                      >
                        <View className="opacity-40">
                          <ProviderGlyph providerID={u.provider} size={18} />
                        </View>
                        <View className="flex-1">
                          <Text className="text-[13px] font-medium text-zinc-500" numberOfLines={1}>
                            {providerMeta(u.provider).label}
                          </Text>
                          <Text className="mt-0.5 text-[10px] leading-4 text-zinc-400">{u.reason}</Text>
                        </View>
                      </View>
                    ))}
                  </View>
                </>
              ) : null}

              {usage.opencode_error ? (
                <Note>{`opencode could not be reached (${usage.opencode_error}), so its own threads are missing from these numbers. The CLI figures above are unaffected.`}</Note>
              ) : null}
              <Note>{`Read on ${usage.hostname || deviceLabel} from opencode's per-message accounting and each CLI's own local history — every turn on that machine, not just the ones sent from this app. Cache reads are billed differently from fresh input, so they stay in their own row.`}</Note>
            </>
          )}
        </View>
      </ScrollView>

      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <View className="flex-1 rounded-2xl border border-zinc-200 bg-white px-4 py-3">
      <Text className="text-[10px] font-semibold uppercase text-zinc-400">{label}</Text>
      <Text className="mt-1 text-xl font-bold text-zinc-900" numberOfLines={1}>{value}</Text>
      <Text className="mt-0.5 text-[10px] text-zinc-400" numberOfLines={1}>{sub}</Text>
    </View>
  );
}

function Toggle({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className={`rounded-lg px-2.5 py-1 ${active ? "bg-zinc-900" : "bg-zinc-100"}`}
    >
      <Text className={`text-[11px] font-medium ${active ? "text-white" : "text-zinc-600"}`}>{label}</Text>
    </Pressable>
  );
}

function MixRow({ label, value, total, first }: { label: string; value: number; total: number; first?: boolean }) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <View className={`px-4 py-2.5 ${first ? "" : "border-t border-zinc-100"}`}>
      <View className="flex-row items-center gap-3">
        <Text className="flex-1 text-[12px] text-zinc-600">{label}</Text>
        <Text style={{ fontFamily: MONO_FONT }} className="text-[12px] text-zinc-900">{formatTokens(value)}</Text>
        <Text style={{ fontFamily: MONO_FONT }} className="w-[42px] text-right text-[11px] text-zinc-400">
          {`${pct.toFixed(0)}%`}
        </Text>
      </View>
    </View>
  );
}

function SectionLabel({ children }: { children: string }) {
  return <Text className="mb-2 mt-6 px-1 text-[10px] font-semibold uppercase text-zinc-400">{children}</Text>;
}

function Note({ children }: { children: string }) {
  return <Text className="mt-3 px-1 text-[11px] leading-4 text-zinc-400">{children}</Text>;
}

function Empty({ text }: { text: string }) {
  return (
    <View className="px-4 py-4">
      <Text className="text-[13px] text-zinc-500">{text}</Text>
    </View>
  );
}

function ChartSkeleton() {
  return (
    <View className="mt-4">
      <View className="flex-row gap-2.5">
        {[0, 1].map((i) => (
          <View key={i} className="flex-1 rounded-2xl border border-zinc-200 bg-white px-4 py-3">
            <View className="h-2 w-12 rounded-full bg-zinc-100" />
            <View className="mt-2 h-5 w-20 rounded-full bg-zinc-100" />
            <View className="mt-2 h-2 w-14 rounded-full bg-zinc-100" />
          </View>
        ))}
      </View>
      <View className="mt-4 rounded-2xl border border-zinc-200 bg-white px-4 py-4">
        <View className="h-[132px] flex-row items-end gap-1">
          {[24, 40, 18, 62, 34, 48, 28, 56, 22, 44].map((h, i) => (
            <View key={i} className="flex-1 rounded-t bg-zinc-100" style={{ height: h }} />
          ))}
        </View>
      </View>
    </View>
  );
}
