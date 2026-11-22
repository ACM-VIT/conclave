import dotenv from "dotenv";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Loads the SFU's .env files once, before anything reads a setting: the
// configuration, and the crash reporting that starts before it so a
// configuration that fails as it loads is still reported.
const sfuPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(sfuPackageRoot, "..", "..");
const webAppRoot = path.resolve(repoRoot, "apps", "web");

// First match wins (dotenv default does not override existing process.env vars).
// Order: most-specific (sfu package) -> shared web app (matches Next.js) -> repo root.
// This keeps local dev in sync without forcing the user to maintain duplicate secrets.
const envCandidates = [
  path.join(sfuPackageRoot, ".env.local"),
  path.join(sfuPackageRoot, ".env"),
  path.join(webAppRoot, ".env.local"),
  path.join(webAppRoot, ".env"),
  path.join(repoRoot, ".env.local"),
  path.join(repoRoot, ".env"),
];

const files: string[] = [];
let source: string = process.env.SFU_SECRET
  ? "process.env (set before SFU bootstrap)"
  : "fallback literal";

for (const envPath of envCandidates) {
  if (existsSync(envPath)) {
    const beforeSecret = process.env.SFU_SECRET;
    dotenv.config({ path: envPath });
    files.push(envPath);
    if (!beforeSecret && process.env.SFU_SECRET) {
      source = envPath;
    }
  }
}

export const loadedEnvFiles: readonly string[] = files;
export const secretSource: string = source;
