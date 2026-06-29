import { describe, expect, it } from "vitest";
import { extractRtpPayload } from "../server/transcript/rtp.js";

describe("extractRtpPayload", () => {
  it("extracts payload from a basic RTP packet", () => {
    const header = Buffer.from([
      0x80, 0x78, 0x00, 0x01, 0x00, 0x00, 0x00, 0x10, 0x12, 0x34, 0x56, 0x78,
    ]);
    const payload = Buffer.from([0x11, 0x22, 0x33]);

    expect(extractRtpPayload(Buffer.concat([header, payload]))).toEqual(payload);
  });

  it("skips csrc and extension headers", () => {
    const header = Buffer.from([
      0x91, 0x78, 0x00, 0x01, 0x00, 0x00, 0x00, 0x10, 0x12, 0x34, 0x56, 0x78,
      0xaa, 0xbb, 0xcc, 0xdd, 0xbe, 0xde, 0x00, 0x01, 0x99, 0x88, 0x77, 0x66,
    ]);
    const payload = Buffer.from([0x44, 0x55]);

    expect(extractRtpPayload(Buffer.concat([header, payload]))).toEqual(payload);
  });

  it("returns null for invalid packets", () => {
    expect(extractRtpPayload(Buffer.from([0x40, 0x78]))).toBeNull();
  });
});
