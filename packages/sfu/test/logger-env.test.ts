import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// The SFU's own .env.local, the first file config/env.ts reads.
const sfuEnvLocal = fileURLToPath(new URL("../.env.local", import.meta.url));

afterEach(() => {
  vi.doUnmock("dotenv");
  vi.doUnmock("fs");
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("the SFU logger", () => {
  it("takes its level from the SFU's .env files, even when it loads before them", async () => {
    vi.resetModules();
    vi.stubEnv("SFU_LOG_LEVEL", "");
    vi.stubEnv("LOG_LEVEL", "");
    // Only the SFU's .env.local exists, and it asks for debug logs.
    vi.doMock("fs", async (importOriginal) => ({
      ...(await importOriginal<typeof import("fs")>()),
      existsSync: (file: string) => file === sfuEnvLocal,
    }));
    vi.doMock("dotenv", () => ({
      default: {
        config: ({ path }: { path: string }) => {
          if (path === sfuEnvLocal) process.env.SFU_LOG_LEVEL = "debug";
          return {};
        },
      },
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    // The order server.ts loads them in: its reporting imports the logger,
    // and only then the settings, which load the .env files.
    const { Logger } = await import("../utilities/loggers.js");
    await import("../config/env.js");
    Logger.debug("debug probe");

    expect(log).toHaveBeenCalledWith(expect.stringContaining("debug probe"));
  });
});
