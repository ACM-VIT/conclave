import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMeetingPath, buildMeetingUrl } from "../src/lib/meeting-links";
import {
  canonicalizeSfuClientId,
  findScheduledMeetingForLink,
  resolveBrowserSfuClientId,
} from "../src/lib/sfu-client-id";
import { SfuTooOldForBookingsError } from "../src/lib/scheduled-meeting-lookup";

afterEach(() => vi.unstubAllEnvs());

const ROOM = "abc-defg-hij";

type Booking = { id: string; clientId: string; roomCode: string };

const sfuLookup = (bookedUnder: string[]) => async (clientId: string) => {
  const family = canonicalizeSfuClientId(clientId) === "conclave" ? ["conclave", "default", "public"] : [clientId];
  const tenant = family.find((candidate) => bookedUnder.includes(candidate));
  return tenant ? { id: `booking-${tenant}`, clientId: tenant, roomCode: ROOM } : null;
};

const tenantOpenedBy = async (path: string, bookedUnder: string[] = []) => {
  const linked =
    new URL(path, "https://web.test").searchParams.get("clientId") ?? undefined;
  const found = await findScheduledMeetingForLink<Partial<Booking>>(
    linked,
    sfuLookup(bookedUnder),
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

  it("keeps an old bare link's server-default booking when two tenants booked the code", async () => {
    deployment("other", "conclave");

    expect(await tenantOpenedBy(`/${ROOM}`, ["conclave", "other"])).toBe("conclave");
  });

  it("does not put a named Conclave room behind the server default's booking", async () => {
    deployment("other", "other");
    const path = buildMeetingPath({ roomCode: ROOM, clientId: "conclave" });

    expect(
      await findScheduledMeetingForLink("conclave", sfuLookup(["other"])),
    ).toBeNull();
    expect(await tenantOpenedBy(path, ["other"])).toBe("conclave");
  });

  it("asks the SFU only for the tenant a link names, or for the server default and then Conclave on a bare link", async () => {
    deployment("conclave", "acme");
    const asked: string[] = [];
    const recording = async (clientId: string) => {
      asked.push(clientId);
      return null;
    };

    await findScheduledMeetingForLink("beta", recording);
    await findScheduledMeetingForLink("default", recording);
    await findScheduledMeetingForLink(undefined, recording);

    expect(asked).toEqual(["beta", "conclave", "acme", "conclave"]);
  });

  it("never takes a booking the SFU answers for another tenant, or one that names no tenant", async () => {
    deployment("conclave", "conclave");
    const answer = (meeting: Partial<Booking>) => async () => meeting;

    expect(await findScheduledMeetingForLink("acme", answer({ id: "b", clientId: "conclave", roomCode: ROOM }))).toBeNull();
    expect(await findScheduledMeetingForLink("acme", answer({ id: "b", roomCode: ROOM }))).toBeNull();
  });

  it("passes an older SFU's refusal on instead of guessing a tenant", async () => {
    deployment("conclave", "conclave");
    const olderSfu = async () => {
      throw new SfuTooOldForBookingsError();
    };

    await expect(findScheduledMeetingForLink("acme", olderSfu)).rejects.toBeInstanceOf(SfuTooOldForBookingsError);
    await expect(findScheduledMeetingForLink(undefined, olderSfu)).rejects.toBeInstanceOf(SfuTooOldForBookingsError);
  });
});
