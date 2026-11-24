import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMeetingPath, buildMeetingUrl, meetingTarget, parseMeetingInput } from "../src/lib/meeting-links";
import {
  canonicalizeSfuClientId,
  findScheduledMeetingForLink,
  resolveBrowserSfuClientId,
} from "../src/lib/sfu-client-id";

afterEach(() => vi.unstubAllEnvs());

const ROOM = "abc-defg-hij";

type Booking = { id: string; clientId: string; roomCode: string };
type SfuOptions = { reportsClientId?: boolean; sfuDefault?: string };
const olderSfu = { reportsClientId: false };

const sfuLookup =
  (bookedUnder: string[], { reportsClientId = true, sfuDefault }: SfuOptions = {}) =>
  async (clientId: string) => {
    const serverDefault =
      sfuDefault ?? canonicalizeSfuClientId(process.env.SFU_CLIENT_ID) ?? "conclave";
    for (const candidate of [clientId, serverDefault, "conclave", "default", "public"]) {
      if (bookedUnder.includes(candidate)) {
        return reportsClientId
          ? { id: `booking-${candidate}`, clientId: candidate, roomCode: ROOM }
          : { id: `booking-${candidate}`, roomCode: ROOM };
      }
    }
    return null;
  };

const tenantOpenedBy = async (
  path: string,
  bookedUnder: string[] = [],
  options?: SfuOptions,
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

  it("labels an older SFU's booking on a bare link with the tenant it was looked up under, as base did", async () => {
    vi.stubEnv("NEXT_PUBLIC_SFU_CLIENT_ID", "acme");
    vi.stubEnv("SFU_CLIENT_ID", "");
    const acmeSfu = { ...olderSfu, sfuDefault: "acme" };

    expect(await tenantOpenedBy(`/${ROOM}`, ["acme"], acmeSfu)).toBe("acme");
  });

  it("keeps gating a named link's own booking on an older SFU that names no tenant", async () => {
    deployment("conclave", "conclave");

    expect(await findScheduledMeetingForLink("acme", sfuLookup(["acme"], olderSfu))).toEqual({
      clientId: "acme",
      meeting: { id: "booking-acme", roomCode: ROOM },
    });
    expect(await findScheduledMeetingForLink("conclave", sfuLookup(["conclave"], olderSfu))).toEqual({
      clientId: "conclave",
      meeting: { id: "booking-conclave", roomCode: ROOM },
    });
    expect(await findScheduledMeetingForLink("acme", sfuLookup(["acme", "conclave"], olderSfu))).toEqual({
      clientId: "acme",
      meeting: { id: "booking-acme", roomCode: ROOM },
    });
  });

  it.each([
    ["the server default's", "beta", ["beta"]],
    ["Conclave's", "conclave", ["conclave"]],
    ["a legacy alias's", "conclave", ["default"]],
  ])(
    "never takes %s booking, which an older SFU falls back to, for a link that names another tenant",
    async (_name, serverDefault, bookedUnder) => {
      deployment("conclave", serverDefault);

      expect(await findScheduledMeetingForLink("acme", sfuLookup(bookedUnder, { ...olderSfu, sfuDefault: serverDefault }))).toBeNull();
      expect(await tenantOpenedBy(`/${ROOM}?clientId=acme`, bookedUnder, { ...olderSfu, sfuDefault: serverDefault })).toBe("acme");
    },
  );

  it("never takes a current SFU's booking that names a different tenant", async () => {
    deployment("conclave", "conclave");

    expect(await findScheduledMeetingForLink("acme", sfuLookup(["conclave"]))).toBeNull();
    expect(await findScheduledMeetingForLink("acme", sfuLookup(["acme"]))).toEqual({
      clientId: "acme",
      meeting: { id: "booking-acme", clientId: "acme", roomCode: ROOM },
    });
  });

  it("labels an older SFU's booking with the server's default when one is set", async () => {
    deployment("acme", "beta");

    expect(await tenantOpenedBy(`/${ROOM}`, ["beta"], olderSfu)).toBe("beta");
  });
});

describe("a pasted meeting link", () => {
  it("joins its own room, whatever the link's host and query", () => {
    expect(parseMeetingInput("https://conclave.acmvit.in/rose-sora-luffy?clientId=conclave")).toEqual({
      roomCode: "rose-sora-luffy",
      clientId: "conclave",
    });
    expect(parseMeetingInput("conclave.acmvit.in/rose-sora-luffy")).toEqual({
      roomCode: "rose-sora-luffy",
      clientId: null,
    });
    expect(parseMeetingInput("http://localhost:3000/abc-defg-hij?clientId=acme#x")).toEqual({
      roomCode: "abc-defg-hij",
      clientId: "acme",
    });
  });

  it("leaves a code being typed as it is typed", () => {
    expect(parseMeetingInput("rose-sora-")).toEqual({ roomCode: "rose-sora-", clientId: null });
    expect(parseMeetingInput("Rose Sora")).toEqual({ roomCode: "rose-sora", clientId: null });
  });

  const ORIGIN = "https://conclave.acmvit.in";
  const pasteOnConclave = (link: string, roomCode = parseMeetingInput(link).roomCode) =>
    meetingTarget(roomCode, parseMeetingInput(link), "conclave");

  it("joins and copies a link that names another tenant in that tenant, and leaves this page's head count out of it", () => {
    const target = pasteOnConclave("http://localhost:3000/abc-defg-hij?clientId=acme");

    expect(target).toEqual({ roomCode: "abc-defg-hij", clientId: "acme", onThisPage: false });
    expect(buildMeetingPath(target)).toBe("/abc-defg-hij?clientId=acme");
    expect(buildMeetingUrl(ORIGIN, target)).toBe(`${ORIGIN}/abc-defg-hij?clientId=acme`);
  });

  it("keeps a link in this tenant, or a bare one, here", () => {
    for (const link of [
      "https://conclave.acmvit.in/abc-defg-hij?clientId=conclave",
      "https://conclave.acmvit.in/abc-defg-hij?clientId=default",
      "conclave.acmvit.in/abc-defg-hij",
      "abc-defg-hij",
    ]) {
      const target = pasteOnConclave(link);
      expect(target, link).toEqual({ roomCode: "abc-defg-hij", clientId: "conclave", onThisPage: true });
      expect(buildMeetingUrl(ORIGIN, target), link).toBe(`${ORIGIN}/abc-defg-hij?clientId=conclave`);
    }
  });

  it("drops the pasted tenant once the code no longer matches the pasted link", () => {
    const target = pasteOnConclave("http://localhost:3000/abc-defg-hij?clientId=acme", "xyz-uvwx-rst");

    expect(target).toEqual({ roomCode: "xyz-uvwx-rst", clientId: "conclave", onThisPage: true });
  });
});
