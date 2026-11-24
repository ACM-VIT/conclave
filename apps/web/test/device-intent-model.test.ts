import { describe, expect, it } from "vitest";
import {
  captureDevices,
  chooseDevice,
  createDeviceIntentStore,
  handOffDevices,
  initialDeviceIntents,
  reduceDeviceIntents,
  publishIntent,
  setDeviceOff,
  type Device,
  type DeviceIntentStore,
  type HeldDevices,
} from "../src/app/lib/device-intent";

const RUNS = Number(process.env.DEVICE_INTENT_MODEL_RUNS ?? 2_000);
const FROM = Number(process.env.DEVICE_INTENT_MODEL_FROM ?? 1);
const STEPS = 60;
const DEVICES = ["audio", "video"] as const;

const randomFrom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

type FakeTrack = { id: string; kind: Device; readyState: "live" | "ended"; stop: () => void };

type Screen = {
  store: DeviceIntentStore;
  held: Record<Device, FakeTrack | null>;
  mounted: boolean;
  devices: HeldDevices;
};

type Open = {
  id: number;
  screen: Screen;
  devices: readonly Device[];
  resolve: (tracks: FakeTrack[]) => void;
  reject: (error: Error) => void;
  done: Promise<unknown>;
};

type Expected = {
  wants: Record<Device, boolean>;
  held: Record<Device, boolean>;
  latest: Record<Device, number | null>;
  meeting: Record<Device, boolean>;
};

const runOnce = async (seed: number): Promise<string[]> => {
  const random = randomFrom(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const problems: string[] = [];
  const tracks: FakeTrack[] = [];
  let trackCount = 0;
  const newTrack = (kind: Device): FakeTrack => {
    trackCount += 1;
    const track: FakeTrack = {
      id: `${kind}-${trackCount}`,
      kind,
      readyState: "live",
      stop: () => {
        track.readyState = "ended";
      },
    };
    tracks.push(track);
    return track;
  };

  const mountScreen = (): Screen => {
    const screen: Screen = {
      store: createDeviceIntentStore(),
      held: { audio: null, video: null },
      mounted: true,
      devices: {
        holds: (device) => screen.held[device]?.readyState === "live",
        keep: (device, track) => {
          const fake = track as unknown as FakeTrack;
          if (!screen.mounted) {
            fake.stop();
            return;
          }
          if (screen.held[device] && screen.held[device] !== fake) screen.held[device]!.stop();
          screen.held[device] = fake;
        },
        drop: (device) => {
          screen.held[device]?.stop();
          screen.held[device] = null;
        },
      },
    };
    return screen;
  };

  let screen = mountScreen();
  const meeting = createDeviceIntentStore();
  let meetingTracks: FakeTrack[] = [];
  let phase: "prejoin" | "joined" | "refused" | "left" = "prejoin";
  let opens: Open[] = [];
  let openCount = 0;
  const expected: Expected = {
    wants: { audio: false, video: false },
    held: { audio: false, video: false },
    latest: { audio: null, video: null },
    meeting: { audio: false, video: false },
  };

  const startCapture = (devices: readonly Device[]) => {
    openCount += 1;
    const id = openCount;
    let resolve!: (tracks: FakeTrack[]) => void;
    let reject!: (error: Error) => void;
    const opened = new Promise<FakeTrack[]>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const done = captureDevices(
      screen.store,
      screen.devices,
      devices,
      () => opened as unknown as Promise<MediaStreamTrack[]>,
    );
    opens.push({ id, screen, devices, resolve, reject, done });
    devices.forEach((device) => {
      expected.wants[device] = true;
      expected.latest[device] = id;
    });
  };

  const attemptJoin = (step: number, action: string) => {
    const published = publishIntent(meeting.get());
    const shown = { audio: meeting.get().audio.chosen, video: meeting.get().video.chosen };
    if (published.isMicOn !== expected.meeting.audio || published.isCameraOn !== expected.meeting.video) {
      problems.push(
        `step ${step} (${action}): the join publishes ${JSON.stringify(published)} but the user's choice is ${JSON.stringify(expected.meeting)}`,
      );
    }
    if (published.isMicOn !== shown.audio || published.isCameraOn !== shown.video) {
      problems.push(`step ${step} (${action}): published ${JSON.stringify(published)} but shown ${JSON.stringify(shown)}`);
    }
    const outcome = pick(["joined", "joined", "temporary", "terminal"] as const);
    if (outcome === "joined") {
      phase = "joined";
      return;
    }
    meeting.dispatch({ type: "release" });
    meetingTracks.forEach((track) => track.stop());
    meetingTracks = [];
    expected.meeting = { audio: false, video: false };
    phase = "refused";
  };

  for (let step = 0; step < STEPS && problems.length === 0; step += 1) {
    const action = pick([
      "toggle",
      "toggle",
      "toggle",
      "allow-both",
      "switch-device",
      "settle",
      "settle",
      "settle",
      "join",
      "retry",
      "in-call-toggle",
      "publish-failed",
      "rejoin",
      "leave",
    ] as const);
    const device = pick(DEVICES);

    if (action === "toggle" && phase === "prejoin") {
      if (screen.store.get()[device].chosen) {
        chooseDevice(screen.store, screen.devices, device, false);
        expected.wants[device] = false;
        expected.latest[device] = null;
        expected.held[device] = false;
      } else {
        startCapture([device]);
      }
    } else if (action === "allow-both" && phase === "prejoin") {
      startCapture(DEVICES);
    } else if (action === "switch-device" && phase === "prejoin" && screen.devices.holds(device)) {
      startCapture([device]);
    } else if (action === "settle" && opens.length > 0) {
      const open = opens.splice(Math.floor(random() * opens.length), 1)[0];
      const refused = random() < 0.1;
      const granted = refused ? [] : open.devices.filter(() => random() < 0.7);
      if (refused) open.reject(new Error("NotAllowedError"));
      else open.resolve(granted.map(newTrack));
      await open.done;
      if (open.screen === screen && phase === "prejoin") {
        open.devices.forEach((kind) => {
          if (expected.latest[kind] !== open.id) return;
          expected.latest[kind] = null;
          if (granted.includes(kind)) expected.held[kind] = true;
          expected.wants[kind] = expected.held[kind];
        });
      }
    } else if (action === "join" && phase === "prejoin") {
      const showing = { mic: screen.store.get().audio.chosen, camera: screen.store.get().video.chosen };
      const handedOff = handOffDevices(screen.store);
      if (handedOff.mic !== showing.mic || handedOff.camera !== showing.camera) {
        problems.push(`step ${step}: the join screen showed ${JSON.stringify(showing)} but handed off ${JSON.stringify(handedOff)}`);
      }
      meeting.dispatch({ type: "set", audio: handedOff.mic, video: handedOff.camera });
      meetingTracks = DEVICES.flatMap((kind) => {
        const track = screen.held[kind];
        const chosen = kind === "audio" ? handedOff.mic : handedOff.camera;
        if (!track || track.readyState !== "live") return [];
        if (!chosen) {
          track.stop();
          return [];
        }
        return [track];
      });
      screen.held = { audio: null, video: null };
      screen.mounted = false;
      expected.meeting = { audio: expected.wants.audio, video: expected.wants.video };
      expected.latest = { audio: null, video: null };
      expected.held = { audio: false, video: false };
      attemptJoin(step, action);
    } else if (action === "retry" && phase === "refused") {
      attemptJoin(step, action);
    } else if (action === "in-call-toggle" && phase === "joined") {
      setDeviceOff(meeting, device, (off) => !off);
      expected.meeting[device] = !expected.meeting[device];
    } else if (action === "publish-failed" && phase === "joined") {
      setDeviceOff(meeting, device, true);
      expected.meeting[device] = false;
    } else if (action === "rejoin" && (phase === "refused" || phase === "left")) {
      screen.mounted = false;
      screen = mountScreen();
      const restore = { audio: random() < 0.5, video: random() < 0.5 };
      screen.store.dispatch({ type: "set", ...restore });
      expected.wants = { ...restore };
      expected.held = { audio: false, video: false };
      expected.latest = { audio: null, video: null };
      phase = "prejoin";
    } else if (action === "leave" && phase === "joined") {
      meeting.dispatch({ type: "release" });
      meetingTracks.forEach((track) => track.stop());
      meetingTracks = [];
      expected.meeting = { audio: false, video: false };
      phase = "left";
    }

    if (phase === "prejoin") {
      for (const kind of DEVICES) {
        const shown = screen.store.get()[kind].chosen;
        if (shown !== expected.wants[kind]) {
          problems.push(`step ${step} (${action}): the ${kind} button shows ${shown ? "on" : "off"} but the user's latest choice is ${expected.wants[kind] ? "on" : "off"}`);
        }
        const holds = screen.devices.holds(kind);
        if (holds && !shown) problems.push(`step ${step} (${action}): a live ${kind} track is held although ${kind} shows off`);
        if (holds !== expected.held[kind]) {
          problems.push(`step ${step} (${action}): ${kind} is ${holds ? "" : "not "}held but should ${expected.held[kind] ? "" : "not "}be`);
        }
      }
    }
    const published = publishIntent(meeting.get());
    if (published.isMicOn !== meeting.get().audio.chosen || published.isCameraOn !== meeting.get().video.chosen) {
      problems.push(`step ${step} (${action}): the meeting publishes ${JSON.stringify(published)} but shows something else`);
    }
    if (phase !== "prejoin" && (published.isMicOn !== expected.meeting.audio || published.isCameraOn !== expected.meeting.video)) {
      problems.push(`step ${step} (${action}): the meeting publishes ${JSON.stringify(published)} but should publish ${JSON.stringify(expected.meeting)}`);
    }
    const owned = new Set<FakeTrack>([
      ...meetingTracks,
      ...DEVICES.flatMap((kind) => (screen.mounted && screen.held[kind] ? [screen.held[kind]!] : [])),
    ]);
    const leaked = tracks.filter((track) => track.readyState === "live" && !owned.has(track));
    if (leaked.length > 0) problems.push(`step ${step} (${action}): live tracks nobody holds: ${leaked.map((track) => track.id).join(", ")}`);
  }
  opens.forEach((open) => open.resolve([]));
  await Promise.all(opens.map((open) => open.done));
  opens = [];
  return problems;
};

describe("device intent under random toggles, grants, joins, refusals, retries and rejoins", () => {
  it(`shows the latest choice, publishes what it shows and holds nothing unchosen across ${RUNS} seeded runs`, async () => {
    const failures: string[] = [];
    for (let seed = FROM; seed < FROM + RUNS && failures.length < 3; seed += 1) {
      const problems = await runOnce(seed);
      if (problems.length > 0) failures.push(`seed ${seed}: ${problems.join(" | ")}`);
    }
    expect(failures).toEqual([]);
  });
});

describe("a device result for an older request", () => {
  it("changes nothing once the user has chosen again", () => {
    const pending = reduceDeviceIntents(initialDeviceIntents, { type: "capture", device: "audio" });
    const turnedOff = reduceDeviceIntents(pending, { type: "choose", device: "audio", chosen: false });
    const reopened = reduceDeviceIntents(turnedOff, { type: "capture", device: "audio" });
    const late = reduceDeviceIntents(reopened, {
      type: "settle",
      device: "audio",
      request: pending.audio.request,
      chosen: false,
    });
    expect(late).toBe(reopened);
    expect(late.audio).toEqual({ chosen: true, request: reopened.audio.request, capturing: true });
  });
});
