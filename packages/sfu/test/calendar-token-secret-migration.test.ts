import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SchedulingCalendarConnection } from "../types.js";
import { hostCalendar } from "../server/controlPlane/schedulingCommands.js";
import { openControlPlane } from "../server/controlPlane/open.js";
import { seed } from "./support/controlPlane.js";

const PADDED = "  padded-sfu-secret-value ";

const calendar: SchedulingCalendarConnection = {
  id: "calendar-1", grantId: "grant-1", clientId: "conclave", profileId: "profile-1", userId: "user-1", provider: "google",
  status: "connected", email: "host@example.test", calendarId: "primary", accessToken: "access-token-value",
  refreshToken: "refresh-token-value", accessTokenExpiresAt: 1_800_000_000_000, scopes: [], connectedAt: 1,
  updatedAt: 1, error: null,
};

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-calendar-secret-"));
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(dir, "conclave.sqlite"));
  vi.stubEnv("CONTROL_PLANE_PERSISTENCE", "sqlite");
  for (const variable of ["SCHEDULING_SQLITE_PATH", "SCHEDULING_PERSISTENCE", "SCHEDULED_MEETINGS_PERSISTENCE", "SCHEDULED_WEBINARS_PERSISTENCE", "REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL", "SCHEDULING_TOKEN_SECRET"]) {
    vi.stubEnv(variable, "");
  }
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const savedTokens = async () => {
  const store = await openControlPlane();
  const saved = await store.read(hostCalendar(calendar.profileId));
  await store.close();
  return { accessToken: saved?.accessToken ?? null, refreshToken: saved?.refreshToken ?? null };
};

describe("calendar tokens saved under a padded SFU_SECRET", () => {
  beforeEach(async () => {
    vi.stubEnv("SFU_SECRET", PADDED);
    const store = await openControlPlane();
    await seed(store, "calendar", calendar);
    await store.close();
  });

  it("still decrypt after SCHEDULING_TOKEN_SECRET takes the exact padded value and SFU_SECRET is trimmed", async () => {
    vi.stubEnv("SCHEDULING_TOKEN_SECRET", PADDED);
    vi.stubEnv("SFU_SECRET", PADDED.trim());
    expect(await savedTokens()).toEqual({ accessToken: "access-token-value", refreshToken: "refresh-token-value" });
  });

  it("are lost if SFU_SECRET is trimmed first", async () => {
    vi.stubEnv("SFU_SECRET", PADDED.trim());
    expect(await savedTokens()).not.toEqual({ accessToken: "access-token-value", refreshToken: "refresh-token-value" });
  });
});
