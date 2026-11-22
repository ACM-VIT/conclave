import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMeetingPath } from "../src/lib/meeting-links";
import {
  canonicalizeSfuClientId,
  resolveBrowserSfuClientId,
  resolveSfuClientIdCandidates,
} from "../src/lib/sfu-client-id";

afterEach(() => vi.unstubAllEnvs());

const ROOM = "abc-defg-hij";

// What /[code] opens: a scheduled meeting found under one of the candidate
// tenants, otherwise the link's tenant, otherwise the browser default.
const tenantOpenedBy = (path: string, bookedUnder: string[] = []) => {
  const linked =
    new URL(path, "https://web.test").searchParams.get("clientId") ?? undefined;
  const booked = resolveSfuClientIdCandidates(linked).find((clientId) =>
    bookedUnder.includes(clientId),
  );
  return booked ?? (canonicalizeSfuClientId(linked) || resolveBrowserSfuClientId());
};

const deployment = (browserDefault: string, serverDefault: string) => {
  vi.stubEnv("NEXT_PUBLIC_SFU_CLIENT_ID", browserDefault);
  vi.stubEnv("SFU_CLIENT_ID", serverDefault);
};

describe("meeting links", () => {
  it.each([
    ["conclave", "conclave", "acme"],
    ["acme", "acme", "conclave"],
    ["acme", "acme", "default"],
    ["acme", "acme", "acme"],
    ["conclave", "conclave", "conclave"],
    ["acme", "conclave", "acme"],
    ["acme", "conclave", "conclave"],
    ["conclave", "acme", "conclave"],
    ["conclave", "acme", "acme"],
  ])(
    "with browser default %s and server default %s, a link to a %s room opens that room",
    (browserDefault, serverDefault, roomClientId) => {
      deployment(browserDefault, serverDefault);

      const path = buildMeetingPath({ roomCode: ROOM, clientId: roomClientId });

      expect(tenantOpenedBy(path)).toBe(canonicalizeSfuClientId(roomClientId));
    },
  );

  it("does not trade the room's tenant for another tenant's booking with the same code", () => {
    deployment("acme", "conclave");
    expect(
      tenantOpenedBy(buildMeetingPath({ roomCode: ROOM, clientId: "acme" }), ["conclave"]),
    ).toBe("acme");

    deployment("conclave", "acme");
    expect(
      tenantOpenedBy(buildMeetingPath({ roomCode: ROOM, clientId: "conclave" }), ["acme"]),
    ).toBe("conclave");
  });

  it("opens a typed code in the browser's default tenant", () => {
    deployment("conclave", "acme");
    expect(tenantOpenedBy(`/${ROOM}`, ["acme"])).toBe("conclave");

    expect(tenantOpenedBy(`/${ROOM}`, ["default"])).toBe("default");
  });

  it("keeps links clean on a deployment that only uses the default tenant", () => {
    deployment("conclave", "conclave");

    expect(buildMeetingPath({ roomCode: ROOM, clientId: "conclave" })).toBe(`/${ROOM}`);
  });
});
