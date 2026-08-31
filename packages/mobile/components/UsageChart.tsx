import { Pressable, Text, View } from "react-native";
import { MONO_FONT } from "../lib/fonts";
import type { UsageDay } from "../lib/api";

export type UsageMetric = "tokens" | "cost";

export function metricValue(day: UsageDay, metric: UsageMetric): number {
  return metric === "tokens" ? day.tokens.total : day.cost;
}

// Scales all the way up: a fortnight of cache-heavy agent turns runs into
// billions, and stopping at M turned 2.94B into a meaningless "2945M".
const TOKEN_UNITS: Array<[number, string]> = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "k"],
];

export function formatTokens(n: number): string {
  for (const [div, suffix] of TOKEN_UNITS) {
    if (n < div) continue;
    const v = n / div;
    // three significant digits, so the number stays the same width whichever
    // unit it lands in
    const text = v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2);
    return `${text.replace(/\.0+$/, "")}${suffix}`;
  }
  return String(n);
}

export function formatCost(n: number): string {
  if (n === 0) return "$0.00";
  // sub-cent totals are the norm on cheap models — two decimals would print
  // every one of them as $0.00
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatMetric(v: number, metric: UsageMetric): string {
  return metric === "tokens" ? formatTokens(v) : formatCost(v);
}

// Bars, one per day, one measure at a time. Tokens and dollars have unrelated
// scales, so the metric toggle switches which one is plotted rather than a
// second y-axis being added — two scales on one frame can't be read.
export default function UsageChart({
  days,
  metric,
  selected,
  onSelect,
  height = 132,
}: {
  days: UsageDay[];
  metric: UsageMetric;
  selected: number | null;
  onSelect: (index: number | null) => void;
  height?: number;
}) {
  const values = days.map((d) => metricValue(d, metric));
  const max = Math.max(...values, 0);
  // index of the tallest bar — the one day that gets a direct label, so the
  // chart never turns into a number on every column
  const peak = max > 0 ? values.indexOf(max) : -1;

  return (
    <View>
      <View className="flex-row items-end justify-between">
        <Text className="text-[10px] text-zinc-400">{max > 0 ? formatMetric(max, metric) : "—"}</Text>
        <Text className="text-[10px] text-zinc-400">{days.length} days</Text>
      </View>

      {/* recessive frame: a top rule at the max and a baseline, nothing else */}
      <View className="mt-1 border-t border-zinc-100" />
      <View style={{ height }} className="flex-row items-end border-b border-zinc-200">
        {days.map((d, i) => {
          const v = values[i];
          const ratio = max > 0 ? v / max : 0;
          // a zero day still draws a 2px stub, so the axis reads as continuous
          // rather than as missing days
          const barHeight = v > 0 ? Math.max(4, Math.round(ratio * (height - 18))) : 2;
          const isSelected = selected === i;
          const labelled = isSelected || (selected === null && i === peak && v > 0);
          return (
            <Pressable
              key={d.date}
              onPress={() => onSelect(isSelected ? null : i)}
              className="flex-1 items-center justify-end"
              style={{ paddingHorizontal: 1 }}
              hitSlop={{ top: 8, bottom: 8 }}
            >
              {labelled ? (
                <Text style={{ fontFamily: MONO_FONT }} className="mb-0.5 text-[9px] text-zinc-500" numberOfLines={1}>
                  {formatMetric(v, metric)}
                </Text>
              ) : null}
              <View
                className={v > 0 ? (isSelected ? "w-full bg-orange-600" : "w-full bg-orange-500") : "w-full bg-zinc-200"}
                style={{
                  height: barHeight,
                  // rounded data-end, square where it meets the baseline
                  borderTopLeftRadius: 4,
                  borderTopRightRadius: 4,
                }}
              />
            </Pressable>
          );
        })}
      </View>

      {/* first / middle / last only — a label under every column collides */}
      <View className="mt-1.5 flex-row justify-between">
        {[0, Math.floor((days.length - 1) / 2), days.length - 1]
          .filter((i, idx, arr) => i >= 0 && arr.indexOf(i) === idx)
          .map((i) => (
            <Text key={i} style={{ fontFamily: MONO_FONT }} className="text-[9px] text-zinc-400">
              {shortDate(days[i]?.date)}
            </Text>
          ))}
      </View>
    </View>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The server sends a plain calendar date; parsing it as a Date would shift it by
// the device's offset, so it's split rather than parsed.
export function shortDate(iso?: string): string {
  if (!iso) return "";
  const [, m, d] = iso.split("-");
  const month = MONTHS[Number(m) - 1];
  return month ? `${month} ${Number(d)}` : iso;
}
