import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sfu-client-id", () => import("../src/lib/sfu-client-id"));

import { buildMeetingPath, buildMeetingUrl } from "../src/lib/meeting-links";
import { canonicalizeSfuClientId, resolveBrowserSfuClientId } from "../src/lib/sfu-client-id";
import { codeFieldTenant, resolveCodeField } from "../src/app/lib/utils";
import {
  PREJOIN_HANDOFF_MAX_AGE_MS,
  savePrejoinHandoff,
  takePrejoinHandoff,
} from "../src/app/lib/prejoin-handoff";

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
  it("lands on the link's tenant for every deployment default and link tenant", () => {
    const failures: string[] = [];
    for (const deploymentDefault of DEPLOYMENT_DEFAULTS) {
      vi.stubEnv("NEXT_PUBLIC_SFU_CLIENT_ID", deploymentDefault);
      const page = resolveBrowserSfuClientId();
      for (const linkTenant of LINK_TENANTS) {
        const link = `https://conclave.acmvit.in/review-room${
          linkTenant === null ? "" : `?clientId=${encodeURIComponent(linkTenant)}`
        }`;
        const resolution = resolveCodeField(link, ORIGINS);
        const tenant = codeFieldTenant(resolution, page);
        const wanted = canonicalizeSfuClientId(linkTenant) ?? page;
        const target = { roomCode: resolution.code, clientId: tenant.clientId };
        const redirect = landsOn(buildMeetingPath(target));
        const copied = landsOn(buildMeetingUrl("https://conclave.acmvit.in", target));
        const ok =
          resolution.code === "review-room" &&
          tenant.clientId === wanted &&
          tenant.onThisPage === (wanted === page) &&
          redirect === wanted &&
          copied === wanted;
        if (!ok) {
          failures.push(JSON.stringify({ deploymentDefault, linkTenant, tenant, wanted, redirect, copied }));
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps a link without a tenant clean when it stays on the deployment default", () => {
    vi.stubEnv("NEXT_PUBLIC_SFU_CLIENT_ID", "acme");
    expect(buildMeetingPath({ roomCode: "review-room", clientId: "acme" })).toBe("/review-room");
    expect(buildMeetingPath({ roomCode: "review-room", clientId: "conclave" })).toBe(
      "/review-room?clientId=conclave",
    );
    vi.stubEnv("NEXT_PUBLIC_SFU_CLIENT_ID", "");
    expect(buildMeetingPath({ roomCode: "review-room", clientId: "conclave" })).toBe("/review-room");
    expect(buildMeetingPath({ roomCode: "review-room", clientId: "default" })).toBe("/review-room");
    expect(buildMeetingPath({ roomCode: "review-room", clientId: "acme" })).toBe("/review-room?clientId=acme");
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
  const target = { roomCode: "review-room", clientId: "review-alt" };
  const media = { isMicOn: true, isCameraOn: false, isAudioOnly: true };

  it("hands the choices to the destination room once", () => {
    const storage = memoryStorage();
    savePrejoinHandoff(target, media, storage, 1_000);
    expect(takePrejoinHandoff(target, storage, 2_000)).toEqual(media);
    expect(takePrejoinHandoff(target, storage, 2_000)).toBeNull();
  });

  it("drops a handoff for another room, another tenant, or one that is stale or malformed", () => {
    const cases: [string, (storage: ReturnType<typeof memoryStorage>) => void, number][] = [
      ["other room", (s) => savePrejoinHandoff({ ...target, roomCode: "other-room" }, media, s, 1_000), 2_000],
      ["other tenant", (s) => savePrejoinHandoff({ ...target, clientId: "conclave" }, media, s, 1_000), 2_000],
      ["stale", (s) => savePrejoinHandoff(target, media, s, 1_000), 1_001 + PREJOIN_HANDOFF_MAX_AGE_MS],
      ["from the future", (s) => savePrejoinHandoff(target, media, s, 5_000), 1_000],
      ["not JSON", (s) => s.setItem("conclave:prejoin-handoff", "{"), 2_000],
      [
        "wrong types",
        (s) => s.setItem("conclave:prejoin-handoff", JSON.stringify({ ...target, savedAt: 1_000, isMicOn: "yes", isCameraOn: false, isAudioOnly: false })),
        2_000,
      ],
    ];
    for (const [label, save, now] of cases) {
      const storage = memoryStorage();
      save(storage);
      expect({ label, media: takePrejoinHandoff(target, storage, now) }).toEqual({ label, media: null });
      expect({ label, left: storage.values.size }).toEqual({ label, left: 0 });
    }
  });

  it("never restores a camera together with audio-only mode", () => {
    const storage = memoryStorage();
    storage.setItem(
      "conclave:prejoin-handoff",
      JSON.stringify({ ...target, savedAt: 1_000, isMicOn: false, isCameraOn: true, isAudioOnly: true }),
    );
    expect(takePrejoinHandoff(target, storage, 2_000)).toEqual({ isMicOn: false, isCameraOn: false, isAudioOnly: true });
  });
});
