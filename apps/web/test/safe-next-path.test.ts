import { describe, expect, it } from "vitest";
import { toSafeNextPath } from "../src/app/lib/safe-next-path";

describe("toSafeNextPath", () => {
  it.each(["/", "/abc-def-ghi", "/schedule?tab=events#top", "/w/launch"])("keeps the same-origin path %s", (path) => {
    expect(toSafeNextPath(path)).toBe(path);
  });

  it.each([
    "https://evil.com",
    "//evil.com",
    "/\\evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "\\\\evil.com",
    "evil.com",
    "",
    null,
    undefined,
  ])("refuses %j", (value) => {
    expect(toSafeNextPath(value)).toBeNull();
  });
});
