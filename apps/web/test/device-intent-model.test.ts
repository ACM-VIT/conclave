import { describe, expect, it } from "vitest";
import {
  createDeviceIntentStore,
  initialDeviceIntents,
  reduceDeviceIntents,
  publishIntent,
  setDeviceOff,
  type Device,
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

type Claim = { id: number; device: Device; request: number };

type Expected = {
  chosen: Record<Device, boolean>;
  latest: Record<Device, number | null>;
};

const runOnce = (seed: number): string[] => {
  const random = randomFrom(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const problems: string[] = [];
  const meeting = createDeviceIntentStore();
  let phase: "joinCard" | "joined" | "refused" | "left" = "joinCard";
  let claims: Claim[] = [];
  let claimCount = 0;
  const expected: Expected = {
    chosen: { audio: false, video: false },
    latest: { audio: null, video: null },
  };

  const expectAllOff = () => {
    expected.chosen = { audio: false, video: false };
    expected.latest = { audio: null, video: null };
  };

  const choose = (device: Device, chosen: boolean) => {
    if (expected.chosen[device] !== chosen) expected.latest[device] = null;
    expected.chosen[device] = chosen;
  };

  const attemptJoin = (step: number, action: string) => {
    const published = publishIntent(meeting.get());
    if (published.isMicOn !== expected.chosen.audio || published.isCameraOn !== expected.chosen.video) {
      problems.push(
        `step ${step} (${action}): the join publishes ${JSON.stringify(published)} but the join card handed over ${JSON.stringify(expected.chosen)}`,
      );
    }
    if (pick(["joined", "joined", "temporary", "terminal"] as const) === "joined") {
      phase = "joined";
      return;
    }
    meeting.dispatch({ type: "release" });
    expectAllOff();
    phase = "refused";
  };

  for (let step = 0; step < STEPS && problems.length === 0; step += 1) {
    const action = pick([
      "join",
      "join",
      "retry",
      "toggle",
      "toggle",
      "capture",
      "capture",
      "settle",
      "settle",
      "settle",
      "publish-failed",
      "back-to-join-card",
      "leave",
    ] as const);
    const device = pick(DEVICES);

    if (action === "join" && (phase === "joinCard" || phase === "refused")) {
      const live = { audio: random() < 0.5, video: random() < 0.5 };
      meeting.dispatch({ type: "set", ...live });
      expected.chosen = { ...live };
      expected.latest = { audio: null, video: null };
      attemptJoin(step, action);
    } else if (action === "retry" && phase === "refused") {
      attemptJoin(step, action);
    } else if (action === "toggle" && phase === "joined") {
      setDeviceOff(meeting, device, (off) => !off);
      choose(device, !expected.chosen[device]);
    } else if (action === "capture" && phase === "joined") {
      claimCount += 1;
      const request = meeting.dispatch({ type: "capture", device })[device].request;
      claims.push({ id: claimCount, device, request });
      expected.chosen[device] = true;
      expected.latest[device] = claimCount;
    } else if (action === "settle" && claims.length > 0) {
      const claim = claims.splice(Math.floor(random() * claims.length), 1)[0];
      const granted = random() < 0.7;
      meeting.dispatch({ type: "settle", device: claim.device, request: claim.request, chosen: granted });
      if (expected.latest[claim.device] === claim.id) {
        expected.latest[claim.device] = null;
        expected.chosen[claim.device] = granted;
      }
    } else if (action === "publish-failed" && phase === "joined") {
      setDeviceOff(meeting, device, true);
      choose(device, false);
    } else if (action === "back-to-join-card" && (phase === "refused" || phase === "left")) {
      phase = "joinCard";
    } else if (action === "leave" && phase === "joined") {
      meeting.dispatch({ type: "release" });
      expectAllOff();
      phase = "left";
    }

    const published = publishIntent(meeting.get());
    if (published.isMicOn !== expected.chosen.audio || published.isCameraOn !== expected.chosen.video) {
      problems.push(
        `step ${step} (${action}): the meeting publishes ${JSON.stringify(published)} but the latest choice is ${JSON.stringify(expected.chosen)}`,
      );
    }
    for (const kind of DEVICES) {
      const intent = meeting.get()[kind];
      const starting = expected.latest[kind] !== null;
      if (intent.capturing !== starting) {
        problems.push(
          `step ${step} (${action}): ${kind} ${intent.capturing ? "shows" : "does not show"} as starting but a capture is ${starting ? "" : "not "}pending`,
        );
      }
      if (intent.capturing && !intent.chosen) {
        problems.push(`step ${step} (${action}): ${kind} is starting although it shows off`);
      }
    }
    if (phase !== "joined" && (published.isMicOn || published.isCameraOn)) {
      problems.push(`step ${step} (${action}): a device is still chosen after the call ended or was refused`);
    }
  }
  return problems;
};

describe("device intent under random joins, refusals, retries, toggles, captures and late results", () => {
  it(`publishes the latest choice and lets no late result change it across ${RUNS} seeded runs`, () => {
    const failures: string[] = [];
    for (let seed = FROM; seed < FROM + RUNS && failures.length < 3; seed += 1) {
      const problems = runOnce(seed);
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
