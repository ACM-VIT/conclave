import { describe, expect, it } from "vitest";
import {
  formatConclaveSiteVersionLabel,
  isConclaveSiteVersionResponse,
  isSameConclaveSiteVersion,
  normalizeConclaveSiteVersion,
} from "../src/app/lib/site-version";

describe("site version helpers", () => {
  it("normalizes Cloudflare version metadata", () => {
    expect(
      normalizeConclaveSiteVersion({
        id: "  version-123  ",
        tag: "  main  ",
        timestamp: "  2026-06-29T09:00:00.000Z  ",
      }),
    ).toEqual({
      id: "version-123",
      tag: "main",
      timestamp: "2026-06-29T09:00:00.000Z",
    });
  });

  it("falls back when metadata is unavailable", () => {
    expect(normalizeConclaveSiteVersion(null, "local-dev")).toEqual({
      id: "local-dev",
      tag: null,
      timestamp: null,
    });
  });

  it("validates the public API response shape", () => {
    expect(
      isConclaveSiteVersionResponse({
        serviceVersion: {
          id: "version-123",
          tag: null,
          timestamp: null,
        },
      }),
    ).toBe(true);
    expect(
      isConclaveSiteVersionResponse({
        serviceVersion: {
          id: "version-123",
        },
      }),
    ).toBe(false);
  });

  it("compares and labels versions", () => {
    const first = {
      id: "abcdef123456",
      tag: null,
      timestamp: null,
    };
    const second = {
      id: "abcdef123456",
      tag: "main",
      timestamp: null,
    };

    expect(isSameConclaveSiteVersion(first, first)).toBe(true);
    expect(isSameConclaveSiteVersion(first, second)).toBe(false);
    expect(formatConclaveSiteVersionLabel(first)).toBe("abcdef12");
    expect(formatConclaveSiteVersionLabel(second)).toBe("main");
  });
});
