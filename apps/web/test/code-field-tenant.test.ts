import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sfu-client-id", () => import("../src/lib/sfu-client-id"));

import { buildMeetingPath, buildMeetingUrl } from "../src/lib/meeting-links";
import { canonicalizeSfuClientId, resolveBrowserSfuClientId } from "../src/lib/sfu-client-id";
import { codeFieldTenant, resolveCodeField } from "../src/app/lib/utils";
import {
  REJOIN_MAX_AGE_MS,
  applyRejoinMedia,
  clearRejoinIntent,
  readRejoinIntent,
  saveRejoinIntent,
} from "../src/app/lib/rejoin-intent";

const ORIGINS = ["https://conclave.acmvit.in"];
const DEPLOYMENT_DEFAULTS = ["conclave", "acme", "default", ""];
const LINK_TENANTS = [null, "conclave", "default", "public", "acme", "review-alt", "a b", "x".repeat(65)];

const landsOn = (path: string) =>
  canonicalizeSfuClientId(new URL(path, "https://conclave.acmvit.in").searchParams.get("clientId")) ||
  resolveBrowserSfuClientId();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("joining a Conclave link from the code field", () => {
  it("lands on the link's tenant wherever the link is made and wherever it is opened", () => {
    const failures: string[] = [];
    for (const madeOn of DEPLOYMENT_DEFAULTS) {
      for (const openedOn of DEPLOYMENT_DEFAULTS) {
        for (const linkTenant of LINK_TENANTS) {
          vi.stubEnv("NEXT_PUBLIC_SFU_CLIENT_ID", madeOn);
          const page = resolveBrowserSfuClientId();
          const link = `https://conclave.acmvit.in/review-room${
            linkTenant === null ? "" : `?clientId=${encodeURIComponent(linkTenant)}`
          }`;
          const resolution = resolveCodeField(link, ORIGINS);
          const tenant = codeFieldTenant(resolution, page);
          const wanted = canonicalizeSfuClientId(linkTenant) ?? page;
          const target = { roomCode: resolution.code, clientId: tenant.clientId };
          const path = buildMeetingPath(target);
          const url = buildMeetingUrl("https://conclave.acmvit.in", target);
          vi.stubEnv("NEXT_PUBLIC_SFU_CLIENT_ID", openedOn);
          const redirect = landsOn(path);
          const copied = landsOn(url);
          const ok =
            resolution.code === "review-room" &&
            tenant.clientId === wanted &&
            tenant.onThisPage === (wanted === page) &&
            redirect === wanted &&
            copied === wanted;
          if (!ok) {
            failures.push(JSON.stringify({ madeOn, openedOn, linkTenant, tenant, wanted, redirect, copied }));
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("reads the tenant from a link's query exactly as direct navigation does", () => {
    const page = resolveBrowserSfuClientId();
    const directNavigation = (link: string) => {
      const url = new URL(/^https?:/i.test(link) ? link : `https://${link.replace(/^\/\//, "")}`);
      const first = new URLSearchParams(url.search).getAll("clientId")[0]?.trim();
      const sanitized = first && /^[a-zA-Z0-9._:-]{1,64}$/.test(first) ? first : undefined;
      return canonicalizeSfuClientId(sanitized) || page;
    };
    const rows: [string, string][] = [
      ["?clientId=review-alt", "review-alt"],
      ["??clientId=review-alt", page],
      ["?&clientId=review-alt", "review-alt"],
      ["?clientId=review-alt&clientId=other", "review-alt"],
      ["?client%49d=review-alt", "review-alt"],
      ["?clientId=%72eview-alt", "review-alt"],
      ["?%3FclientId=review-alt", page],
      ["?;clientId=review-alt", page],
      ["?clientid=review-alt", page],
      ["?clientId=", page],
      ["?clientId=a+b", page],
      ["?clientId=%20review-alt%20", "review-alt"],
      ["#clientId=review-alt", page],
      ["?ref=chat#clientId=review-alt", page],
      ["?clientId=review-alt#top", "review-alt"],
      ["/?clientId=review-alt", "review-alt"],
      ["?clientId=default", "conclave"],
    ];
    const failures: string[] = [];
    for (const prefix of ["https://conclave.acmvit.in/review-room", "conclave.acmvit.in/review-room", "//conclave.acmvit.in/review-room"]) {
      for (const [suffix, expected] of rows) {
        const link = `${prefix}${suffix}`;
        const resolution = resolveCodeField(link, ORIGINS);
        const field = codeFieldTenant(resolution, page).clientId;
        const direct = directNavigation(link);
        if (resolution.code !== "review-room" || field !== expected || direct !== expected) {
          failures.push(JSON.stringify({ link, code: resolution.code, field, direct, expected }));
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("names the tenant in every generated link", () => {
    for (const deploymentDefault of DEPLOYMENT_DEFAULTS) {
      vi.stubEnv("NEXT_PUBLIC_SFU_CLIENT_ID", deploymentDefault);
      expect(buildMeetingPath({ roomCode: "review-room", clientId: "acme" })).toBe("/review-room?clientId=acme");
      expect(buildMeetingPath({ roomCode: "review-room", clientId: "conclave" })).toBe("/review-room?clientId=conclave");
      expect(buildMeetingPath({ roomCode: "review-room", clientId: "default" })).toBe("/review-room?clientId=conclave");
      expect(buildMeetingUrl("https://conclave.acmvit.in/", { roomCode: "review-room", clientId: "public" })).toBe(
        "https://conclave.acmvit.in/review-room?clientId=conclave",
      );
    }
    expect(buildMeetingPath({ roomCode: "review-room", clientId: null })).toBe("/review-room");
    expect(buildMeetingPath({ roomCode: "review-room", clientId: "a b" })).toBe("/review-room");
  });
});

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
};

describe("carrying pre-join choices across a tenant switch", () => {
  const target = { roomId: "review-room", clientId: "review-alt" };
  const media = { isMicOn: true, isCameraOn: false, isAudioOnly: true };

  it("hands the choices to the destination room until it clears them", () => {
    const storage = memoryStorage();
    saveRejoinIntent(target, media, storage, 1_000);
    expect(readRejoinIntent(target, storage, 2_000)).toEqual(media);
    expect(readRejoinIntent({ ...target, roomId: " Review-Room " }, storage, 2_000)).toEqual(media);
    clearRejoinIntent(storage);
    expect(readRejoinIntent(target, storage, 2_000)).toBeNull();
  });

  it("ignores choices saved for another room or tenant, or that are stale or malformed", () => {
    const cases: [string, (storage: ReturnType<typeof memoryStorage>) => void, number][] = [
      ["other room", (s) => saveRejoinIntent({ ...target, roomId: "other-room" }, media, s, 1_000), 2_000],
      ["other tenant", (s) => saveRejoinIntent({ ...target, clientId: "conclave" }, media, s, 1_000), 2_000],
      ["stale", (s) => saveRejoinIntent(target, media, s, 1_000), 1_001 + REJOIN_MAX_AGE_MS],
      ["from the future", (s) => saveRejoinIntent(target, media, s, 5_000), 1_000],
      ["not JSON", (s) => s.setItem("conclave:rejoin", "{"), 2_000],
      [
        "wrong types",
        (s) => s.setItem("conclave:rejoin", JSON.stringify({ ...target, savedAt: 1_000, isMicOn: "yes", isCameraOn: false, isAudioOnly: false })),
        2_000,
      ],
      [
        "no tenant, as an older rejoin entry",
        (s) => s.setItem("conclave:rejoin", JSON.stringify({ roomId: "review-room", savedAt: 1_000, ...media })),
        2_000,
      ],
    ];
    for (const [label, save, now] of cases) {
      const storage = memoryStorage();
      save(storage);
      expect({ label, media: readRejoinIntent(target, storage, now) }).toEqual({ label, media: null });
    }
  });

  it("never restores a camera together with audio-only mode", () => {
    const storage = memoryStorage();
    storage.setItem(
      "conclave:rejoin",
      JSON.stringify({ ...target, savedAt: 1_000, isMicOn: false, isCameraOn: true, isAudioOnly: true }),
    );
    expect(readRejoinIntent(target, storage, 2_000)).toEqual({ isMicOn: false, isCameraOn: false, isAudioOnly: true });
  });
});

const fakeControls = () => {
  const state = { audioOnly: false, mic: false, camera: false, choices: 0 };
  let releaseMic = () => {};
  const calls: string[] = [];
  const controls = {
    userChoices: () => state.choices,
    isAudioOnly: () => state.audioOnly,
    isMicOn: () => state.mic,
    isCameraOn: () => state.camera,
    turnOnAudioOnly: () => {
      calls.push("audio-only");
      state.audioOnly = true;
    },
    turnOnMic: () =>
      new Promise<void>((resolve) => {
        calls.push("mic");
        releaseMic = () => {
          state.mic = true;
          resolve();
        };
      }),
    turnOnCamera: async () => {
      calls.push("camera");
      state.camera = true;
    },
  };
  const user = (change: () => void) => {
    state.choices += 1;
    change();
  };
  return { state, calls, controls, user, releaseMic: () => releaseMic() };
};

describe("restoring carried media choices on the destination join card", () => {
  it("restores every saved choice when the user touches nothing", async () => {
    const fake = fakeControls();
    const done = applyRejoinMedia({ isMicOn: true, isCameraOn: true, isAudioOnly: false }, fake.controls);
    await Promise.resolve();
    fake.releaseMic();
    await done;
    expect(fake.calls).toEqual(["mic", "camera"]);
    expect(fake.state).toMatchObject({ mic: true, camera: true });
  });

  it("never turns the camera back on after the user turned it off during a slow mic restore", async () => {
    const fake = fakeControls();
    const done = applyRejoinMedia({ isMicOn: true, isCameraOn: true, isAudioOnly: false }, fake.controls);
    await Promise.resolve();
    fake.user(() => (fake.state.camera = true));
    fake.user(() => (fake.state.camera = false));
    fake.releaseMic();
    await done;
    expect(fake.calls).toEqual(["mic"]);
    expect(fake.state.camera).toBe(false);
  });

  it("stops before the mic once the user has made any media choice", async () => {
    const fake = fakeControls();
    const done = applyRejoinMedia(
      { isMicOn: true, isCameraOn: false, isAudioOnly: true },
      {
        ...fake.controls,
        turnOnAudioOnly: () => {
          fake.controls.turnOnAudioOnly();
          fake.user(() => (fake.state.audioOnly = false));
        },
      },
    );
    await done;
    expect(fake.calls).toEqual(["audio-only"]);
    expect(fake.state).toMatchObject({ audioOnly: false, mic: false });
  });
});
