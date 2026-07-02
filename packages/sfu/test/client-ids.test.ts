import { describe, expect, it } from "vitest";
import {
  canonicalizeClientId,
  clientIdCandidates,
  CONCLAVE_CLIENT_ID,
} from "../server/clientIds.js";
import { getRoomChannelId } from "../server/rooms.js";

describe("client ID canonicalization", () => {
  it("maps legacy web client IDs to conclave", () => {
    expect(canonicalizeClientId("default")).toBe(CONCLAVE_CLIENT_ID);
    expect(canonicalizeClientId("public")).toBe(CONCLAVE_CLIENT_ID);
    expect(canonicalizeClientId(" public ")).toBe(CONCLAVE_CLIENT_ID);
  });

  it("keeps custom client IDs separate", () => {
    expect(canonicalizeClientId("partner-a")).toBe("partner-a");
  });

  it("uses the same room channel for public, default, and conclave", () => {
    expect(getRoomChannelId("public", "room-1")).toBe("conclave:room-1");
    expect(getRoomChannelId("default", "room-1")).toBe("conclave:room-1");
    expect(getRoomChannelId("conclave", "room-1")).toBe("conclave:room-1");
  });

  it("keeps legacy IDs only as fallback candidates", () => {
    const candidates = clientIdCandidates("public");
    expect(candidates[0]).toBe("conclave");
    expect(candidates).toContain("default");
    expect(candidates).toContain("public");
  });
});
