import { useEffect, useMemo, useState } from "react";
import { Text, View, Pressable, ScrollView, ActivityIndicator, RefreshControl, TextInput, Alert, BackHandler } from "react-native";
import Swipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { fetchProjects, createProject, renameProject, deleteProject, fetchFsList, fetchSessions, type Project, type FsEntry, type Auth } from "../lib/api";
import RenameSheet from "./RenameSheet";
import FolderGlyph from "./FolderGlyph";
import { BarsGlyph, CircleButton, GridGlyph } from "./Glyphs";
import { Chevron } from "./DeviceCard";
import { MONO_FONT } from "../lib/fonts";

export default function ProjectPicker({
  tunnelUrl,
  auth,
  deviceName,
  deviceOnline,
  onPicked,
  onOpenUsage,
  onOpenProviders,
  onBack,
}: {
  tunnelUrl: string;
  auth: Auth;
  deviceName: string;
  deviceOnline?: boolean;
  onPicked: (p: Project) => void;
  // this screen is the only device-scoped list, so it carries the way into
  // that device's own pages — its usage and its agent-CLI inventory
  onOpenUsage: () => void;
  onOpenProviders: () => void;
  onBack: () => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [cwd, setCwd] = useState("");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [pathInput, setPathInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<Project | null>(null);
  const [renameText, setRenameText] = useState("");
  const [threadCounts, setThreadCounts] = useState<Record<string, number>>({});
  const insets = useSafeAreaInsets();

  const load = async () => {
    try {
      setProjects(await fetchProjects(tunnelUrl, auth));
      setErr(null);
    } catch (e: any) {
      setErr(e.message || "Could not load projects");
    }
    // Counted client-side from the full session list — same source and the
    // same `!archived` filter ThreadList itself uses, so the number here
    // always matches what opening the project actually shows. Failure is
    // non-fatal: the count line just doesn't render.
    try {
      const sessions = await fetchSessions(tunnelUrl, auth);
      const counts: Record<string, number> = {};
      for (const s of sessions) {
        if (s.archived || !s.project_id) continue;
        counts[s.project_id] = (counts[s.project_id] || 0) + 1;
      }
      setThreadCounts(counts);
    } catch {}
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tunnelUrl]);

  // `browsing` is local state the route above can't see, so its own back step
  // has to be handled here. Registered only while browsing — otherwise the
  // navigator's own handler (which pops back to the device list) stays in charge.
  // RN calls the most recently registered handler first, so this wins while it's
  // subscribed and the stack pop resumes as soon as it unsubscribes.
  useEffect(() => {
    if (!browsing) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      setBrowsing(false);
      return true;
    });
    return () => sub.remove();
  }, [browsing]);

  const totalThreads = useMemo(
    () => projects.reduce((n, p) => n + (threadCounts[p.id] || 0), 0),
    [projects, threadCounts]
  );

  const startRename = (p: Project) => {
    setRenameText(p.name);
    setRenaming(p);
  };

  const saveRename = async () => {
    if (!renaming) return;
    const name = renameText.trim();
    const target = renaming;
    setRenaming(null);
    if (!name || name === target.name) return;
    setProjects((prev) => prev.map((p) => (p.id === target.id ? { ...p, name } : p)));
    try {
      await renameProject(tunnelUrl, auth, target.id, name);
    } catch (e: any) {
      setErr(e.message || "Could not rename project");
      load();
    }
  };

  const confirmDelete = (p: Project) => {
    Alert.alert("Remove project?", p.path, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          setProjects((prev) => prev.filter((x) => x.id !== p.id));
          try {
            await deleteProject(tunnelUrl, auth, p.id);
          } catch (e: any) {
            setErr(e.message || "Could not remove project");
            load();
          }
        },
      },
    ]);
  };

  const renderRowActions = (p: Project, _progress: unknown, _translation: unknown, swipeable: { close: () => void }) => (
    <View style={{ flexDirection: "row", height: "100%" }}>
      <Pressable
        onPress={() => {
          swipeable.close();
          startRename(p);
        }}
        style={{ width: 76, height: "100%", alignItems: "center", justifyContent: "center", backgroundColor: "#e4e4e7" }}
      >
        <Text className="text-[11px] font-semibold text-zinc-700">Rename</Text>
      </Pressable>
      <Pressable
        onPress={() => {
          swipeable.close();
          confirmDelete(p);
        }}
        style={{ width: 76, height: "100%", alignItems: "center", justifyContent: "center", backgroundColor: "#ef4444" }}
      >
        <Text className="text-[11px] font-semibold text-white">Remove</Text>
      </Pressable>
    </View>
  );

  const browse = async (path?: string) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetchFsList(tunnelUrl, auth, path);
      setCwd(r.cwd);
      setPathInput(r.cwd);
      setEntries(r.entries);
      setBrowsing(true);
    } catch (e: any) {
      setErr(e.message || "Could not list that directory");
    }
    setBusy(false);
  };

  const useDirectory = async (path: string) => {
    setBusy(true);
    setErr(null);
    try {
      const p = await createProject(tunnelUrl, auth, path);
      onPicked(p);
    } catch (e: any) {
      setErr(e.message || "Could not use that directory");
    }
    setBusy(false);
  };

  const parentOf = (path: string) => {
    const trimmed = path.replace(/\/+$/, "");
    const idx = trimmed.lastIndexOf("/");
    return idx > 0 ? trimmed.slice(0, idx) : "/";
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <SafeAreaView className="flex-1 bg-zinc-50">
      <View className="flex-row items-center gap-2 px-4 pb-1 pt-1">
        <Pressable
          onPress={browsing ? () => setBrowsing(false) : onBack}
          className="flex-row items-center gap-1.5 py-1 pr-2 active:opacity-60"
          hitSlop={8}
        >
          <Chevron direction="left" color="#52525b" size={7} />
          <Text className="text-sm text-zinc-600">Back</Text>
        </Pressable>
        <View className="flex-1" />
        {!browsing ? (
          <View className="flex-row gap-2">
            <CircleButton label="Usage" onPress={onOpenUsage}>
              <BarsGlyph />
            </CircleButton>
            <CircleButton label="Providers" onPress={onOpenProviders}>
              <GridGlyph />
            </CircleButton>
          </View>
        ) : null}
      </View>

      {err ? (
        <View className="mx-5 mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5">
          <Text className="text-xs leading-4 text-red-700">{err}</Text>
        </View>
      ) : null}

      {!browsing ? (
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: insets.bottom + 96 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#f97316" colors={["#f97316"]} />}
        >
          <View className="mx-auto w-full max-w-md">
            <Text className="text-2xl font-bold text-zinc-900">Projects</Text>
            {/* device identity sits with the count rather than in the header —
                the header row belongs to Back and the two actions now */}
            <View className="mt-1.5 flex-row items-center gap-1.5">
              <View className={`h-1.5 w-1.5 rounded-full ${deviceOnline === false ? "bg-zinc-300" : "bg-emerald-500"}`} />
              <Text style={{ fontFamily: MONO_FONT }} className="text-[11px] text-zinc-500" numberOfLines={1}>
                {deviceName}
              </Text>
              <Text className="flex-1 text-xs text-zinc-400" numberOfLines={1}>
                {loading
                  ? "loading…"
                  : projects.length === 0
                    ? "· nothing added yet"
                    : `· ${projects.length} ${projects.length === 1 ? "project" : "projects"}${totalThreads ? ` · ${totalThreads} ${totalThreads === 1 ? "thread" : "threads"}` : ""}`}
              </Text>
            </View>

            <View className="mt-4 gap-2.5">
              {loading ? (
                <ProjectSkeleton />
              ) : projects.length === 0 ? (
                <EmptyProjects onAdd={() => browse()} />
              ) : (
                projects.map((p) => (
                  <Swipeable
                    key={p.id}
                    renderRightActions={(progress, translation, swipeable) => renderRowActions(p, progress, translation, swipeable)}
                    overshootRight={false}
                    containerStyle={{ borderRadius: 16, overflow: "hidden" }}
                  >
                    <Pressable
                      onPress={() => onPicked(p)}
                      // see ThreadList: the row must stay opaque or the swipe
                      // actions behind it show through.
                      style={{ backgroundColor: "#ffffff" }}
                      className="rounded-2xl border border-zinc-200 px-4 py-3.5 active:bg-zinc-100"
                    >
                      <View className="flex-row items-center gap-3">
                        <FolderGlyph color="#fdba74" size={18} />
                        <Text className="flex-1 text-[15px] font-semibold text-zinc-900" numberOfLines={1}>{p.name}</Text>
                        <Chevron />
                      </View>
                      {/* the tail of a path identifies it; the /Users/… head
                          almost never does, so that's what gets clipped */}
                      <Text
                        style={{ fontFamily: MONO_FONT }}
                        className="mt-1 text-[11px] text-zinc-400"
                        numberOfLines={1}
                        ellipsizeMode="head"
                      >
                        {p.path}
                      </Text>
                      <View className="mt-3 flex-row items-center gap-2 border-t border-zinc-100 pt-2.5">
                        {threadCounts[p.id] ? (
                          <View className="rounded-full bg-zinc-100 px-2 py-0.5">
                            <Text className="text-[10px] font-semibold text-zinc-600">
                              {threadCounts[p.id]} {threadCounts[p.id] === 1 ? "thread" : "threads"}
                            </Text>
                          </View>
                        ) : (
                          <Text className="text-[11px] text-zinc-400">No threads yet</Text>
                        )}
                      </View>
                    </Pressable>
                  </Swipeable>
                ))
              )}
            </View>

            {projects.length > 0 ? (
              <Text className="mt-3 px-1 text-[11px] leading-4 text-zinc-400">
                Swipe a project for rename or remove. Removing it here leaves the folder on the device untouched.
              </Text>
            ) : null}
          </View>
        </ScrollView>
      ) : null}

      {!browsing ? (
        <Pressable
          onPress={() => browse()}
          style={{ position: "absolute", right: 20, bottom: insets.bottom + 20, elevation: 4 }}
          className="flex-row items-center gap-1.5 rounded-full bg-orange-500 px-4 py-3.5 shadow-lg active:opacity-90"
        >
          <Text className="text-base font-bold text-white">+</Text>
          <Text className="text-[13px] font-bold text-white">Add project</Text>
        </Pressable>
      ) : null}

      {browsing ? (
        <View className="flex-1">
          <View className="px-5 pb-3 pt-1">
            <Text className="text-2xl font-bold text-zinc-900">Add project</Text>
            <Text className="mt-1 text-xs text-zinc-500">Pick a folder on {deviceName}</Text>
          </View>

          <View className="flex-row items-center gap-2 border-y border-zinc-200 bg-white px-4 py-2.5">
            <TextInput
              value={pathInput}
              onChangeText={setPathInput}
              onSubmitEditing={() => browse(pathInput)}
              placeholder="/path/to/project"
              placeholderTextColor="#a1a1aa"
              autoCapitalize="none"
              autoCorrect={false}
              style={{ fontFamily: MONO_FONT }}
              className="flex-1 rounded-lg bg-zinc-100 px-3 py-2 text-xs text-zinc-900"
            />
            <Pressable onPress={() => browse(pathInput)} className="rounded-lg bg-zinc-900 px-3 py-2 active:opacity-80">
              <Text className="text-xs font-semibold text-white">Go</Text>
            </Pressable>
          </View>

          <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 14 }}>
            <View className="mx-auto w-full max-w-md">
              <Text style={{ fontFamily: MONO_FONT }} className="mb-2 px-1 text-[10px] text-zinc-400" numberOfLines={1} ellipsizeMode="head">
                {cwd || "/"}
              </Text>
              <View className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
                {cwd !== "/" ? (
                  <Pressable onPress={() => browse(parentOf(cwd))} className="flex-row items-center gap-3 px-4 py-3 active:bg-zinc-100">
                    <View className="h-[18px] w-[18px] items-center justify-center">
                      <Chevron direction="up" color="#a1a1aa" size={7} />
                    </View>
                    <Text className="text-[13px] text-zinc-500">Up one level</Text>
                  </Pressable>
                ) : null}
                {entries.map((e, i) => (
                  <Pressable
                    key={e.path}
                    onPress={() => browse(e.path)}
                    className={`flex-row items-center gap-3 px-4 py-3 active:bg-zinc-100 ${i === 0 && cwd === "/" ? "" : "border-t border-zinc-100"}`}
                  >
                    <FolderGlyph color="#d4d4d8" size={18} />
                    <Text className="flex-1 text-[13px] text-zinc-900" numberOfLines={1}>{e.name}</Text>
                    <Chevron color="#d4d4d8" />
                  </Pressable>
                ))}
                {entries.length === 0 && cwd ? (
                  <View className="px-4 py-4">
                    <Text className="text-[13px] text-zinc-500">No sub-folders here</Text>
                  </View>
                ) : null}
              </View>
              {busy ? <ActivityIndicator className="mt-4" /> : null}
            </View>
          </ScrollView>

          <View className="border-t border-zinc-200 bg-white px-5 pb-5 pt-3">
            <Text style={{ fontFamily: MONO_FONT }} className="mb-2 text-[10px] text-zinc-400" numberOfLines={1} ellipsizeMode="head">
              {cwd || "—"}
            </Text>
            <Pressable
              onPress={() => useDirectory(cwd)}
              disabled={busy || !cwd}
              className={`items-center rounded-xl bg-orange-500 px-4 py-3.5 ${busy || !cwd ? "opacity-60" : "active:opacity-90"}`}
            >
              <Text className="text-sm font-bold text-white" numberOfLines={1}>Use this folder</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {renaming ? (
        <RenameSheet
          title="Rename project"
          placeholder="Project name"
          value={renameText}
          onChangeText={setRenameText}
          onCancel={() => setRenaming(null)}
          onSave={saveRename}
        />
      ) : null}

      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

function EmptyProjects({ onAdd }: { onAdd: () => void }) {
  return (
    <View className="items-center rounded-2xl border border-dashed border-zinc-300 bg-white px-6 py-8">
      <FolderGlyph color="#e4e4e7" size={30} />
      <Text className="mt-3 text-sm font-semibold text-zinc-900">No projects yet</Text>
      <Text className="mt-1.5 text-center text-xs leading-5 text-zinc-500">
        A project is just a folder on this device. Pick one and its threads live under it.
      </Text>
      <Pressable onPress={onAdd} className="mt-4 rounded-xl bg-zinc-900 px-4 py-2.5 active:opacity-80">
        <Text className="text-xs font-semibold text-white">Choose a folder</Text>
      </Pressable>
    </View>
  );
}

// Sized like the real cards so the list doesn't jump when projects land.
function ProjectSkeleton() {
  return (
    <View className="gap-2.5">
      {[0, 1, 2].map((i) => (
        <View key={i} className="rounded-2xl border border-zinc-200 bg-white px-4 py-3.5">
          <View className="flex-row items-center gap-3">
            <View className="h-[18px] w-[18px] rounded bg-zinc-100" />
            <View className="h-3.5 w-1/2 rounded-full bg-zinc-100" />
          </View>
          <View className="mt-2 h-2.5 w-3/4 rounded-full bg-zinc-100" />
          <View className="mt-3 border-t border-zinc-100 pt-2.5">
            <View className="h-3 w-20 rounded-full bg-zinc-100" />
          </View>
        </View>
      ))}
    </View>
  );
}
