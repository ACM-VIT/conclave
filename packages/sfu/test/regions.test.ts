import { describe, expect, it } from "vitest";
import {
  normalizeSfuRegion,
  resolveConfiguredSfuRegion,
} from "../server/regions.js";

describe("normalizeSfuRegion", () => {
  it("canonicalizes operator region identifiers", () => {
    expect(normalizeSfuRegion("  ME-Central-1  ")).toBe("me-central-1");
    expect(normalizeSfuRegion("DXB")).toBe("dxb");
    expect(normalizeSfuRegion("eu.west:edge_1")).toBe("eu.west:edge_1");
  });

  it("rejects missing, unsafe, and ambiguous labels", () => {
    expect(normalizeSfuRegion(undefined)).toBeNull();
    expect(normalizeSfuRegion(42)).toBeNull();
    expect(normalizeSfuRegion(" ")).toBeNull();
    expect(normalizeSfuRegion("dubai west")).toBeNull();
    expect(normalizeSfuRegion("/dubai")).toBeNull();
    expect(normalizeSfuRegion("dubai-")).toBeNull();
    expect(normalizeSfuRegion("a".repeat(65))).toBeNull();
  });
});

describe("resolveConfiguredSfuRegion", () => {
  it("keeps region configuration optional", () => {
    expect(resolveConfiguredSfuRegion(undefined)).toBeNull();
    expect(resolveConfiguredSfuRegion("  ")).toBeNull();
  });

  it("fails fast when an explicitly configured region is invalid", () => {
    expect(resolveConfiguredSfuRegion("EU-West-1")).toBe("eu-west-1");
    expect(() => resolveConfiguredSfuRegion("eu west 1")).toThrow(
      /SFU_REGION/,
    );
  });
});
