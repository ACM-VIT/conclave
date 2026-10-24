import { stringHash } from "facehash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../src/app/api/avatar/route";
import { AVATAR_COLORS } from "../src/lib/avatar-svg";
vi.mock("@/lib/avatar-svg", () => import("../src/lib/avatar-svg"));

afterEach(() => vi.unstubAllGlobals());
const avatar = (name: string, options: Record<string, string> = {}) => GET(new Request(
  `http://localhost/api/avatar?${new URLSearchParams({ name, format: "svg", ...options })}`,
));

describe("avatar image route", () => {
  it.each(["Conclave", "Ada", "李", "☃", "<script>alert(1)</script>"])("renders a deterministic SVG for %s without loading fonts or WASM", async (name) => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("External rendering resources are unavailable"); }));
    const response = avatar(name, { size: "96" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(response.headers.get("cache-control")).toContain("immutable");
    const svg = await response.text();
    expect(svg).toContain('width="96" height="96"');
    expect(svg).toContain(`fill="${AVATAR_COLORS[stringHash(name) % AVATAR_COLORS.length]}"`);
    expect(svg).not.toMatch(/<script|onload=|https?:\/\/(?!www.w3.org)/);
    expect(await avatar(name, { size: "96" }).text()).toBe(svg);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("escapes initials and rejects colour injection", async () => {
    const svg = await avatar("<unsafe", { showInitial: "true", colors: '\"/><script>alert(1)</script>,#abc', variant: "solid" }).text();
    expect(svg).toContain("&lt;</text>");
    expect(svg).toContain('fill="#abc"');
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("radialGradient");
  });

  it.each([['-1', 16], ['9999999', 2000], ['invalid', 400]])("bounds requested size %s", async (size, expected) => {
    expect(await avatar("Ada", { size }).text()).toContain(`width="${expected}" height="${expected}"`);
  });

  it("returns a bounded text error for missing or excessive names", () => {
    expect(avatar("").status).toBe(400);
    expect(avatar("x".repeat(513)).status).toBe(400);
  });
});
