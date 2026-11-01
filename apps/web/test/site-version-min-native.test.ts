import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/sfu/join/route";
import {
  isConclaveSiteVersionResponse,
  resolveConclaveMinNativeVersion,
} from "../src/app/lib/site-version";
import { getConclaveVersionResponse } from "../src/app/lib/site-version.server";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("Worker context unavailable");
  },
}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/sfu-user-auth", () => ({ lookupScheduledWebinarByRoomId: vi.fn() }));
vi.mock("@/lib/sfu-client-id", () => import("../src/lib/sfu-client-id"));
vi.mock("@/lib/sfu-super-admin", () => import("../src/lib/sfu-super-admin"));
vi.mock("@/lib/sfu-url", () => import("../src/lib/sfu-url"));
vi.mock("@/lib/sfu-routing-policy", () => import("../src/lib/sfu-routing-policy"));
vi.mock("@/app/lib/site-version", () => import("../src/app/lib/site-version"));

beforeEach(() => {
  getSession.mockResolvedValue(null);
  vi.stubEnv("CONCLAVE_MIN_NATIVE_VERSION_IOS", "");
  vi.stubEnv("CONCLAVE_MIN_NATIVE_VERSION_ANDROID", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("minimum native version", () => {
  it("defaults both platforms to 2.0.0", () => {
    expect(resolveConclaveMinNativeVersion({})).toEqual({ ios: "2.0.0", android: "2.0.0" });
  });

  it("takes a dotted numeric override per platform and ignores anything else", () => {
    expect(resolveConclaveMinNativeVersion({
      CONCLAVE_MIN_NATIVE_VERSION_IOS: " 2.1.0 ",
      CONCLAVE_MIN_NATIVE_VERSION_ANDROID: "2.0.0-beta",
    })).toEqual({ ios: "2.1.0", android: "2.0.0" });
    for (const value of ["latest", "2..0", "v2.1", "2.1.0.0.1", ""]) {
      expect(resolveConclaveMinNativeVersion({ CONCLAVE_MIN_NATIVE_VERSION_IOS: value }).ios).toBe("2.0.0");
    }
  });

  it("is carried by /api/version and still reads as a web version payload", async () => {
    vi.stubEnv("CONCLAVE_MIN_NATIVE_VERSION_ANDROID", "2.0.3");
    const response = await getConclaveVersionResponse();
    expect(response.minNativeVersion).toEqual({ ios: "2.0.0", android: "2.0.3" });
    expect(isConclaveSiteVersionResponse(JSON.parse(JSON.stringify(response)))).toBe(true);
  });

  it("is carried by the join response", async () => {
    vi.stubEnv("SFU_SECRET", "min-native-test-secret");
    vi.stubEnv("SFU_DEBUG_SECRET", "0");
    vi.stubEnv("SFU_URL", "http://localhost:3031");
    vi.stubEnv("SFU_URLS", "http://localhost:3031");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      local: true,
      owner: { instanceUrl: "http://localhost:3031" },
      draining: false,
    })));
    const response = await POST(new Request("http://localhost/api/sfu/join", {
      method: "POST",
      body: JSON.stringify({ roomId: "room", sessionId: "session" }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as { token: string; minNativeVersion: unknown };
    expect(body.token).toEqual(expect.any(String));
    expect(body.minNativeVersion).toEqual({ ios: "2.0.0", android: "2.0.0" });
  });
});
