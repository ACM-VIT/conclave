import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMeetingPath } from "../src/lib/meeting-links";
import {
  canonicalizeSfuClientId,
  findScheduledMeetingForLink,
  resolveBrowserSfuClientId,
} from "../src/lib/sfu-client-id";

afterEach(() => vi.unstubAllEnvs());

const ROOM = "abc-defg-hij";

type Booking = { clientId: string; roomCode: string };
const olderSfu = { reportsClientId: false };

// The SFU's by-room lookup: the asked tenant first, then the deployment's
// default and Conclave's legacy ids, returning the booking with its own id.
const sfuLookup =
  (bookedUnder: string[], { reportsClientId = true } = {}) =>
  async (clientId: string) => {
    const serverDefault = canonicalizeSfuClientId(process.env.SFU_CLIENT_ID) ?? "conclave";
    for (const candidate of [clientId, serverDefault, "conclave", "default", "public"]) {
      if (bookedUnder.includes(candidate)) {
        return reportsClientId
          ? { clientId: candidate, roomCode: ROOM }
          : { roomCode: ROOM };
      }
    }
    return null;
  };

// What /[code] opens: a scheduled meeting found for the link, otherwise the
// link's tenant, otherwise the browser default.
const tenantOpenedBy = async (
  path: string,
  bookedUnder: string[] = [],
  options?: { reportsClientId?: boolean },
) => {
  const linked =
    new URL(path, "https://web.test").searchParams.get("clientId") ?? undefined;
  const found = await findScheduledMeetingForLink<Partial<Booking>>(
    linked,
    sfuLookup(bookedUnder, options),
  );
  return found?.clientId ?? (canonicalizeSfuClientId(linked) || resolveBrowserSfuClientId());
};

const deployment = (browserDefault: string, serverDefault: string) => {
  vi.stubEnv("NEXT_PUBLIC_SFU_CLIENT_ID", browserDefault);
  vi.stubEnv("SFU_CLIENT_ID", serverDefault);
};

describe("meeting links", () => {
  it.each([
    ["conclave", "conclave"],
    ["default", "conclave"],
    ["acme", "acme"],
  ])("always name the %s room's tenant", (clientId, linked) => {
    deployment("conclave", "conclave");

    expect(buildMeetingPath({ roomCode: ROOM, clientId })).toBe(`/${ROOM}?clientId=${linked}`);
  });

  it.each([
    ["conclave", "conclave", "acme"],
    ["acme", "conclave", "conclave"],
    ["acme", "conclave", "acme"],
    ["conclave", "acme", "conclave"],
  ])(
    "with browser default %s and server default %s, a new link to a %s room opens it even when both tenants booked the code",
    async (browserDefault, serverDefault, roomClientId) => {
      deployment(browserDefault, serverDefault);

      const path = buildMeetingPath({ roomCode: ROOM, clientId: roomClientId });

      expect(await tenantOpenedBy(path, ["conclave", "acme"])).toBe(roomClientId);
    },
  );

  it("does not trade a named tenant for another tenant's booking with the same code", async () => {
    deployment("acme", "conclave");

    expect(
      await tenantOpenedBy(buildMeetingPath({ roomCode: ROOM, clientId: "acme" }), ["conclave"]),
    ).toBe("acme");
  });

  it("opens an old bare booking link in the booking's tenant, as before", async () => {
    deployment("acme", "conclave");

    expect(await tenantOpenedBy(`/${ROOM}`, ["conclave"])).toBe("conclave");
    expect(await tenantOpenedBy(`/${ROOM}`, ["default"])).toBe("default");
  });

  it("opens a typed code with no booking in the browser's default room", async () => {
    deployment("acme", "conclave");

    expect(await tenantOpenedBy(`/${ROOM}`)).toBe("acme");
  });

  it("never labels an older SFU's booking with the browser default", async () => {
    vi.stubEnv("NEXT_PUBLIC_SFU_CLIENT_ID", "acme");
    vi.stubEnv("SFU_CLIENT_ID", "");

    expect(await tenantOpenedBy(`/${ROOM}`, ["conclave"], olderSfu)).toBe("conclave");
    expect(await tenantOpenedBy(`/${ROOM}?clientId=conclave`, ["conclave"], olderSfu)).toBe(
      "conclave",
    );
  });
});

