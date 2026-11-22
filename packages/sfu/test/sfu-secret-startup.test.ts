import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

const loadConfig = (secret: string) =>
  spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "await import('./config/config.ts')"], {
    cwd: packageDir,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production", SFU_SECRET: secret },
    encoding: "utf8",
  });

describe("SFU_SECRET at startup", () => {
  // Calendar token encryption hashes the raw SFU_SECRET while the rest of the
  // SFU uses the trimmed value, so padding must never reach either.
  it("refuses a secret with surrounding whitespace", () => {
    for (const secret of [" padded-secret-value", "padded-secret-value \n"]) {
      const result = loadConfig(secret);
      expect(result.status, JSON.stringify(secret)).not.toBe(0);
      expect(result.stderr).toMatch(/SFU_SECRET has leading or trailing whitespace/);
    }
  });

  it("accepts an unpadded secret", () => {
    const result = loadConfig("unpadded-secret-value");
    expect(result.status, result.stderr).toBe(0);
  });
});
