import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveControlPlaneConfig, resolveControlPlaneMode } from "../server/controlPlane/open.js";

const REDIS_VARIABLES = ["SFU_PERSISTENCE_REDIS_URL", "SFU_REDIS_URL", "REDIS_URL", "SFU_PERSISTENCE_REDIS_KEY_PREFIX"];

beforeEach(() => {
  for (const variable of [...REDIS_VARIABLES, "CONTROL_PLANE_PERSISTENCE"]) vi.stubEnv(variable, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the control-plane config read from a given environment", () => {
  it("takes the Redis URL and key prefix from that environment, not the process's", () => {
    const env = { SFU_PERSISTENCE_REDIS_URL: "redis://given:6379", SFU_PERSISTENCE_REDIS_KEY_PREFIX: "given:prefix:" };
    expect(resolveControlPlaneMode(env)).toBe("redis");
    expect(resolveControlPlaneConfig(env)).toMatchObject({
      mode: "redis",
      redisUrl: "redis://given:6379",
      keyPrefix: "given:prefix",
    });
  });

  it("ignores a Redis URL that only the process has", () => {
    vi.stubEnv("REDIS_URL", "redis://process-only:6379");
    vi.stubEnv("SFU_PERSISTENCE_REDIS_KEY_PREFIX", "process:prefix");
    expect(resolveControlPlaneMode({})).toBe("sqlite");
    expect(resolveControlPlaneConfig({})).toMatchObject({
      mode: "sqlite",
      redisUrl: "",
      keyPrefix: "conclave:sfu:persistence",
    });
  });
});
