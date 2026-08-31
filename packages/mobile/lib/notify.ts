import * as Notifications from "expo-notifications";

// A finished turn is the one moment the user is not looking at the app: they
// sent a prompt and put the phone down. Everything here is LOCAL notification
// only — the app schedules it itself when it sees the turn end, which works
// while it is foregrounded or recently backgrounded, and needs no push
// credentials of any kind.
//
// It does NOT wake a suspended app. Delivering to a phone that has been asleep
// for minutes needs a real push from the device's own kusal daemon, which in
// turn needs an Expo project id (`eas init`) or raw FCM/APNs config.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let granted: boolean | null = null;

// Asked once per launch, and only when there is something to announce — an
// app that demands notification permission on first open, before it has ever
// had anything to say, is the kind users deny outright.
async function ensurePermission(): Promise<boolean> {
  if (granted !== null) return granted;
  try {
    const existing = await Notifications.getPermissionsAsync();
    granted =
      existing.granted ||
      existing.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
    if (!granted && existing.canAskAgain) {
      const asked = await Notifications.requestPermissionsAsync();
      granted = asked.granted;
    }
  } catch {
    granted = false;
  }
  return granted;
}

export async function notifyTurnFinished(thread: string, failed = false): Promise<void> {
  if (!(await ensurePermission())) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: failed ? "Turn failed" : "Turn finished",
        body: thread,
        sound: true,
      },
      // null = deliver now
      trigger: null,
    });
  } catch {
    // a notification that cannot be posted is never worth breaking a turn over
  }
}
