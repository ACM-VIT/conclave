import { describe, expect, it } from "vitest";
import { GUEST_SEAT_KEY_PREFIX } from "../src/guest-join-claims";
import { namesGuestPassIdentifier } from "../src/guest-pass-identifiers";

const PASS_ID = "gp_AbCdEfGhIjKlMnOpQrStUv";
const SEAT_KEY = `${GUEST_SEAT_KEY_PREFIX}ZyXwVuTsRqPoNmLkJiHgFe`;
const OLDER_KEY = "guest-0196f0a1-0000-7000-8000-000000000123";
const PASS_COOKIE = "__Host-conclave-guest-0a1b2c3d-4e5f6a7b";
const SIGNED = "eyJhbGciOiJIUzI1NiJ9.eyJndWVzdFByb29mIjoiYWJjIn0.c2lnbmF0dXJlLXZhbHVl";

describe("the guest pass identifiers no telemetry event may carry", () => {
  it.each([
    ["a pass id", PASS_ID],
    ["a seat key", SEAT_KEY],
    ["an older guest key", OLDER_KEY],
    ["a pass cookie", `${PASS_COOKIE}=${SIGNED}`],
    ["a signed pass, grant or join token", SIGNED],
    ["one nested in a frame path", { frames: [{ filename: `/_next/static/chunks/${PASS_ID}.js` }] }],
  ])("finds %s", (_name, value) => {
    expect(namesGuestPassIdentifier(value)).toBe(true);
  });

  it("finds nothing in what telemetry does send", () => {
    expect(
      namesGuestPassIdentifier({
        distinct_id: "0196f0a1-0000-7000-8000-000000000000",
        $current_url: "/[code]",
        client_version: "0b2d3b480f4621392a4151d750c90965b7c8b76c",
        call_log: "[Meets] Failed to toggle no-guests",
        frames: [{ filename: "/_next/static/chunks/3u-6_1om1fv26.js", function: "guestProofOf", chunk_id: "147fc2df-e663-5d76-aa13-f67e1e894071" }],
        sfu: "sfu_0123456789abcdef",
        user: "user_0123456789abcdef0123456789abcdef",
        room: "room_fedcba9876543210fedcba9876543210",
        game: "trivia",
      }),
    ).toBe(false);
  });
});
