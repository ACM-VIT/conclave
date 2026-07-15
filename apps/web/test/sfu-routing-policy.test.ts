import { describe, expect, it } from "vitest";
import {
  resolveConfiguredOwnerSfuUrl,
  resolveRoomPlacementCapability,
  resolveReservedSfuUrl,
  selectPreOwnerSfu,
  type SfuRoutingCandidate,
} from "../src/lib/sfu-routing-policy";

describe("selectPreOwnerSfu", () => {
  it("is stable for the same room regardless of response order", () => {
    const candidates: SfuRoutingCandidate[] = [
      { index: 0, url: "https://a.example", availability: "healthy" },
      { index: 1, url: "https://b.example", availability: "healthy" },
    ];

    expect(selectPreOwnerSfu([...candidates].reverse(), "client:room")).toEqual(
      selectPreOwnerSfu(candidates, "client:room"),
    );
  });

  it("prefers a healthy instance over unknown and draining instances", () => {
    const selection = selectPreOwnerSfu(
      [
        { index: 0, url: "https://unknown.example", availability: "unknown" },
        { index: 1, url: "https://healthy.example", availability: "healthy" },
        { index: 2, url: "https://draining.example", availability: "draining" },
      ],
      "client:room",
    );

    expect(selection).toMatchObject({
      kind: "selected",
      availability: "healthy",
      candidate: { url: "https://healthy.example" },
    });
  });

  it("prefers a materially nearer healthy region from edge-observed latency", () => {
    const selection = selectPreOwnerSfu(
      [
        {
          index: 0,
          url: "https://far.example",
          availability: "healthy",
          region: "eu-west",
          latencyMs: 145,
        },
        {
          index: 1,
          url: "https://near.example",
          availability: "healthy",
          region: "me-central",
          latencyMs: 28,
        },
      ],
      "client:room",
    );

    expect(selection).toMatchObject({
      kind: "selected",
      candidate: { url: "https://near.example", region: "me-central" },
      alternatives: [{ url: "https://far.example", region: "eu-west" }],
    });
  });

  it("keeps stable room hashing when healthy latency is within the tie band", () => {
    const candidates: SfuRoutingCandidate[] = [
      {
        index: 0,
        url: "https://a.example",
        availability: "healthy",
        latencyMs: 30,
      },
      {
        index: 1,
        url: "https://b.example",
        availability: "healthy",
        latencyMs: 42,
      },
    ];

    expect(selectPreOwnerSfu(candidates, "client:room")).toEqual(
      selectPreOwnerSfu([...candidates].reverse(), "client:room"),
    );
  });

  it("uses a stable unknown instance instead of a known draining instance", () => {
    const selection = selectPreOwnerSfu(
      [
        { index: 0, url: "https://draining.example", availability: "draining" },
        { index: 1, url: "https://unknown.example", availability: "unknown" },
      ],
      "client:room",
    );

    expect(selection).toMatchObject({
      kind: "selected",
      availability: "unknown",
      candidate: { url: "https://unknown.example" },
    });
  });

  it("reports when every configured instance is explicitly draining", () => {
    expect(
      selectPreOwnerSfu(
        [
          { index: 0, url: "https://a.example", availability: "draining" },
          { index: 1, url: "https://b.example", availability: "draining" },
        ],
        "client:room",
      ),
    ).toEqual({ kind: "all-draining" });
  });

  it("reports an empty candidate pool", () => {
    expect(selectPreOwnerSfu([], "client:room")).toEqual({ kind: "empty" });
  });
});

describe("resolveRoomPlacementCapability", () => {
  it("distinguishes current, legacy, and unavailable status envelopes", () => {
    expect(
      resolveRoomPlacementCapability({
        instanceId: "sfu-a",
        capabilities: { roomPlacement: 1 },
      }),
    ).toBe("supported");
    expect(resolveRoomPlacementCapability({ instanceId: "sfu-a" })).toBe(
      "legacy",
    );
    expect(resolveRoomPlacementCapability(null)).toBe("unknown");
  });
});

describe("resolveConfiguredOwnerSfuUrl", () => {
  const candidates = [
    "https://sfu-a.example",
    "https://sfu-b.example:8443/",
  ];

  it("returns the configured origin for a matching owner URL", () => {
    expect(
      resolveConfiguredOwnerSfuUrl(
        "https://sfu-b.example:8443/socket?ignored=true#fragment",
        candidates,
      ),
    ).toBe("https://sfu-b.example:8443");
  });

  it("normalizes default ports when matching origins", () => {
    expect(
      resolveConfiguredOwnerSfuUrl("https://sfu-a.example:443/", candidates),
    ).toBe("https://sfu-a.example");
  });

  it("rejects an owner outside the configured pool", () => {
    expect(
      resolveConfiguredOwnerSfuUrl("https://attacker.example", candidates),
    ).toBeNull();
  });

  it("rejects credentialed and non-http owner URLs", () => {
    expect(
      resolveConfiguredOwnerSfuUrl("https://user@sfu-a.example", candidates),
    ).toBeNull();
    expect(resolveConfiguredOwnerSfuUrl("file:///tmp/sfu", candidates)).toBeNull();
  });
});

describe("resolveReservedSfuUrl", () => {
  const selectedCandidate: SfuRoutingCandidate = {
    index: 0,
    url: "https://sfu-a.example",
    availability: "healthy",
    instanceId: "sfu-a",
    region: "me-central",
    latencyMs: 20,
  };
  const candidateSfuUrls = [
    "https://sfu-a.example",
    "https://sfu-b.example",
  ];

  it("follows the atomic winner when another regional reservation won", () => {
    expect(
      resolveReservedSfuUrl({
        response: {
          registryMode: "redis",
          local: false,
          assignment: {
            kind: "placement",
            instanceId: "sfu-b",
            instanceUrl: "https://sfu-b.example",
            region: "eu-west",
          },
        },
        selectedCandidate,
        candidateSfuUrls,
      }),
    ).toMatchObject({
      ok: true,
      url: "https://sfu-b.example",
      assignment: { instanceId: "sfu-b", region: "eu-west" },
    });
  });

  it("rejects process-local placement for a multi-SFU pool", () => {
    expect(
      resolveReservedSfuUrl({
        response: {
          registryMode: "local",
          local: true,
          assignment: { kind: "placement", instanceId: "sfu-a" },
        },
        selectedCandidate,
        candidateSfuUrls,
      }),
    ).toEqual({ ok: false, reason: "unsafe-local-registry" });
  });

  it("allows local placement only for a true singleton SFU", () => {
    expect(
      resolveReservedSfuUrl({
        response: {
          registryMode: "local",
          local: true,
          assignment: { kind: "placement", instanceId: "sfu-a" },
        },
        selectedCandidate,
        candidateSfuUrls: ["https://sfu-a.example"],
      }),
    ).toMatchObject({ ok: true, url: "https://sfu-a.example" });
  });

  it("fails closed on malformed or untrusted reservation responses", () => {
    expect(
      resolveReservedSfuUrl({
        response: { registryMode: "redis", local: false, assignment: null },
        selectedCandidate,
        candidateSfuUrls,
      }),
    ).toEqual({ ok: false, reason: "invalid-assignment" });
    expect(
      resolveReservedSfuUrl({
        response: {
          registryMode: "redis",
          local: false,
          assignment: {
            instanceId: "attacker",
            instanceUrl: "https://attacker.example",
          },
        },
        selectedCandidate,
        candidateSfuUrls,
      }),
    ).toEqual({ ok: false, reason: "invalid-assignment" });
  });
});
