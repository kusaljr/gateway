import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Chevron, StatusDot } from "./DeviceCard";
import { MONO_FONT } from "../lib/fonts";
import { absoluteTime, relativeTime, uptime } from "../lib/format";
import type { Device } from "../lib/api";
import type { TunnelChoice } from "../lib/session";

// The device list before any device has been entered: what Cloudflare says the
// account has. It lives on the main screen next to the signed-in device list
// because to the user these are the same thing — machines — and being asked to
// "choose a device" on a screen of its own only made the app feel like it had
// two homes.
export default function TunnelList({
  choices,
  onPick,
  busy,
  current,
  devices,
}: {
  choices: TunnelChoice[];
  onPick: (url: string, tunnelId: string) => void;
  busy: boolean;
  // the machine this app is already signed into, if any — tapping it opens its
  // projects rather than asking Cloudflare Access for a session it already has
  current?: string;
  // What the signed-into backend says about itself. Cloudflare knows a tunnel;
  // only the device knows its own hostname and when it registered, so the two
  // are matched by tunnel id and shown together — for the one machine that is
  // actually reachable, which is the only one that can answer.
  devices?: Device[];
}) {
  return (
    <View className="gap-2">
      {choices.map((c) => (
        <TunnelRow
          key={c.name + c.url}
          choice={c}
          onPick={onPick}
          busy={busy}
          current={current}
          device={(devices || []).find((d) => d.tunnel_id && d.tunnel_id === c.tunnelId)}
        />
      ))}
    </View>
  );
}

function TunnelRow({
  choice: c,
  onPick,
  busy,
  current,
  device,
}: {
  choice: TunnelChoice;
  onPick: (url: string, tunnelId: string) => void;
  busy: boolean;
  current?: string;
  device?: Device;
}) {
  const [open, setOpen] = useState(false);
  // one gate, not two: a row is tappable only when signing into it could
  // actually work. Cloudflare calling the tunnel "healthy" is not that —
  // an ssh jumpbox is healthy too.
  const enabled = c.usable && !busy;
  // Old cached rows were stored before any of this was collected, and the
  // cache is read back verbatim on launch — so every detail field has to be
  // treated as possibly absent rather than assumed present.
  const colos = c.colos || [];
  // "Up" means connections are carrying traffic, which `degraded` also does —
  // it only says some of the four HA connections are missing. Reading it as
  // not-up made a live machine's row print "down 3d" off the timestamp of some
  // earlier blip, which is the opposite of what was happening.
  const live = c.status !== "down" && c.status !== "inactive" && !!c.status;
  const up = live && !!c.activeSince;
  const degraded = c.status === "degraded";
  // Split by family rather than printed as one list: an IPv6 address is long
  // enough that mixing it into a "IP address" row pushes the v4 one out of
  // sight, and which family is which is exactly what the reader is checking.
  const ips = c.originIps || (c.originIp ? [c.originIp] : []);
  const v4 = ips.filter((ip) => !ip.includes(":"));
  const v6 = ips.filter((ip) => ip.includes(":"));

  return (
    <View className={`overflow-hidden rounded-2xl border ${c.usable ? "border-zinc-200 bg-white" : "border-zinc-200/70 bg-white/60"}`}>
      <Pressable
        onPress={() => c.usable && onPick(c.url, c.tunnelId)}
        disabled={!enabled}
        className="flex-row items-center gap-3 px-4 py-3.5 active:bg-zinc-100"
      >
        <StatusDot online={c.usable} />
        <View className="flex-1">
          <View className="flex-row items-center gap-1.5">
            <Text className={`text-[15px] font-semibold ${c.usable ? "text-zinc-900" : "text-zinc-400"}`} numberOfLines={1}>
              {c.name}
            </Text>
            {current && c.url === current ? (
              <View className="rounded-full bg-emerald-50 px-1.5 py-0.5">
                <Text className="text-[9px] font-semibold uppercase text-emerald-700">signed in</Text>
              </View>
            ) : c.looksLikeKusal && c.usable ? (
              <View className="rounded-full bg-orange-50 px-1.5 py-0.5">
                <Text className="text-[9px] font-semibold uppercase text-orange-700">kusal</Text>
              </View>
            ) : null}
            {/* worth saying, not worth blocking on: fewer than the four HA
                connections Cloudflare expects, on a tunnel that still works */}
            {degraded ? (
              <View className="rounded-full bg-amber-50 px-1.5 py-0.5">
                <Text className="text-[9px] font-semibold uppercase text-amber-700">degraded</Text>
              </View>
            ) : null}
          </View>
          <Text
            style={{ fontFamily: MONO_FONT }}
            className={`mt-0.5 text-[11px] ${c.usable ? "text-zinc-400" : "text-zinc-300"}`}
            numberOfLines={1}
            ellipsizeMode="head"
          >
            {c.url ? c.url.replace(/^https?:\/\//, "") : "—"}
          </Text>
          {/* the reason sits in the card as a chip: "why can't I tap this"
              is the only question a disabled row raises */}
          {c.usable ? null : (
            <View className="mt-1.5 self-start rounded-full bg-zinc-100 px-2 py-0.5">
              <Text className="text-[10px] font-medium text-zinc-500" numberOfLines={1}>
                {c.reason}
              </Text>
            </View>
          )}
        </View>
        {c.usable ? <Chevron /> : null}
      </Pressable>

      {/* The two facts worth a permanent line — which machine this is on the
          network, and how long it has been up — stay visible; everything else
          is a tap away, so a list of eight devices is still a list and not a
          wall of metadata. */}
      <Pressable onPress={() => setOpen((v) => !v)} className="flex-row items-center gap-2 border-t border-zinc-100 px-4 py-2.5 active:bg-zinc-100">
        <Text style={{ fontFamily: MONO_FONT }} className="flex-1 text-[10.5px] text-zinc-400" numberOfLines={1} ellipsizeMode="middle">
          {[c.originIp, up ? `up ${uptime(c.activeSince)}` : c.inactiveSince ? `down ${uptime(c.inactiveSince)}` : c.status]
            .filter(Boolean)
            .join("  ·  ")}
        </Text>
        <Text className="text-[10px] font-semibold uppercase text-zinc-400">{open ? "Less" : "Details"}</Text>
        <Chevron direction={open ? "up" : "down"} size={6} />
      </Pressable>

      {open ? (
        <View className="border-t border-zinc-100 bg-zinc-50/70 px-4 py-2.5">
          <Detail
            label="IPv4"
            value={v4.join(", ")}
            mono
            hint={v6.length ? undefined : "as Cloudflare sees this machine dial out"}
          />
          <Detail
            label="IPv6"
            value={v6.join(", ")}
            mono
            hint="cloudflared dials out over IPv6 where the machine has it"
          />
          <Detail
            label={up ? "Up since" : "Last down"}
            value={up ? absoluteTime(c.activeSince) : absoluteTime(c.inactiveSince)}
          />
          <Detail
            label="Connections"
            value={colos.length ? `${colos.length} · ${colos.join(", ")}` : "none"}
            hint={
              degraded
                ? "fewer than the 4 Cloudflare expects — still serving, with less redundancy"
                : colos.length
                  ? "Cloudflare datacenters carrying this tunnel"
                  : undefined
            }
          />
          <Detail label="cloudflared" value={c.clientVersion} mono />
          <Detail label="Serving" value={c.service} mono hint="the local address on that machine" />
          <Detail label="Tunnel status" value={c.status} />
          <Detail label="Tunnel ID" value={c.tunnelId} mono />
          <Detail label="Account" value={c.accountName} />
          <Detail label="Created" value={absoluteTime(c.createdAt)} />
          {/* below the line: what the device says about itself, present only
              once this app has signed into it */}
          <Detail label="Hostname" value={device?.hostname} mono />
          <Detail label="Device ID" value={device?.id} mono />
          <Detail label="Last seen" value={device ? relativeTime(device.last_seen) : undefined} />
        </View>
      ) : null}
    </View>
  );
}

// A row is dropped entirely when its value is missing rather than printed as a
// dash: an older cached device has no IP recorded, and nine em-dashes read as
// "this device is broken" when they only mean "listed before this existed".
function Detail({ label, value, mono, hint }: { label: string; value?: string; mono?: boolean; hint?: string }) {
  if (!value || value === "—") return null;
  return (
    <View className="flex-row items-start gap-3 py-1.5">
      <Text className="w-[92px] text-[11px] text-zinc-400">{label}</Text>
      <View className="flex-1">
        <Text
          style={mono ? { fontFamily: MONO_FONT } : undefined}
          className={`text-right text-[11.5px] text-zinc-700 ${mono ? "" : "font-medium"}`}
          // an IPv6 address does not fit on one line at this width, and a
          // half-shown address is worse than a wrapped one
          numberOfLines={2}
          ellipsizeMode="middle"
        >
          {value}
        </Text>
        {hint ? <Text className="mt-0.5 text-right text-[10px] leading-[13px] text-zinc-400">{hint}</Text> : null}
      </View>
    </View>
  );
}
