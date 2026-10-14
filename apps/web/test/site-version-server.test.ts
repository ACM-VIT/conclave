import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConclaveVersionResponse } from "../src/app/lib/site-version.server";

const { getContext } = vi.hoisted(() => ({ getContext: vi.fn() }));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: getContext,
}));

beforeEach(() => {
  getContext.mockReset();
  vi.stubEnv("NEXT_PUBLIC_CONCLAVE_CLIENT_VERSION", "client-build");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("server version metadata", () => {
  it("reads an existing Worker context without initializing a local runtime", async () => {
    getContext.mockImplementation((options?: { async?: boolean }) => {
      if (options?.async) {
        throw new Error("Local runtime initialization is unavailable");
      }
      return {
        env: {
          CF_VERSION_METADATA: {
            id: "worker-build",
            tag: "staging",
            timestamp: "2026-10-15T00:00:00Z",
          },
        },
      };
    });

    const response = await getConclaveVersionResponse();

    expect(response.serviceVersion).toEqual({
      id: "worker-build",
      tag: "staging",
      timestamp: "2026-10-15T00:00:00Z",
    });
    expect(response.clientVersion.id).toBe("client-build");
  });

  it("uses the client build for concurrent Node requests without a Worker context", async () => {
    getContext.mockImplementation(() => {
      throw new Error("Worker context unavailable");
    });

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => getConclaveVersionResponse()),
    );

    expect(
      responses.every((response) => response.serviceVersion.id === "client-build"),
    ).toBe(true);
    expect(getContext.mock.calls.every((args) => args.length === 0)).toBe(true);
  });
});
