import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractRoomCode,
  generateRoomCode,
  sanitizeRoomCode,
  sanitizeRoomCodeInput,
} from "../src/app/lib/utils";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("meeting codes", () => {
  it("makes readable Meet-style codes", () => {
    const codes = Array.from({ length: 2000 }, () => generateRoomCode());
    for (const code of codes) {
      expect(code).toMatch(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
    }
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("uses every letter evenly instead of favouring the first ones", () => {
    // 234 and above would wrap onto a..v; they must be skipped, not folded.
    let call = 0;
    vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      const bytes = array as unknown as Uint8Array;
      bytes.fill(call++ === 0 ? 250 : 25);
      return array;
    });
    expect(generateRoomCode()).toBe("zzz-zzzz-zzz");
  });

  it("keeps old three-word codes and links working", () => {
    expect(sanitizeRoomCode("poppy-erica-yuki")).toBe("poppy-erica-yuki");
    expect(extractRoomCode("https://conclave.acmvit.in/poppy-erica-yuki")).toBe(
      "poppy-erica-yuki",
    );
  });

  it("accepts new codes typed with spaces, capitals or as a link", () => {
    expect(sanitizeRoomCode("ABC MNOP XYZ")).toBe("abc-mnop-xyz");
    expect(sanitizeRoomCodeInput("abc mnop")).toBe("abc-mnop");
    expect(extractRoomCode("https://conclave.acmvit.in/abc-mnop-xyz")).toBe(
      "abc-mnop-xyz",
    );
    expect(extractRoomCode(" abc-mnop-xyz ")).toBe("abc-mnop-xyz");
  });
});
