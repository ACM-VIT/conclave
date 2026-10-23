import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { native, tokens } from "../src/tokens.ts";
import * as entry from "../src/tokens.js";
import { androidRoles, generateNativeTokens, renderNativeTokens } from "./gen-native-tokens.mjs";

const script = fileURLToPath(new URL("./gen-native-tokens.mjs", import.meta.url));
const swiftPath = "apps/conclave-skip/Sources/Conclave/DesignSystem/DesignTokens.swift";
const assetsPath = "apps/conclave-skip/Darwin/Assets.xcassets";
const resourcesPath = "apps/conclave-skip/Android/app/src/main/res";
const capitalize = (key) => key[0].toUpperCase() + key.slice(1);

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "conclave-native-tokens-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function snapshot(root) {
  return Promise.all([...renderNativeTokens().keys()].map(async (path) => {
    const fullPath = join(root, path);
    try {
      return { path, text: await readFile(fullPath, "utf8"), mtime: (await stat(fullPath)).mtimeMs };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { path, missing: true };
    }
  }));
}

test("explicit TS import and existing JS shim expose an additive native namespace", () => {
  assert.equal(entry.native, native);
  assert.equal(entry.tokens, tokens);
  assert.deepEqual(Object.keys(tokens), ["color", "space", "radius", "font", "text", "border", "opacity", "motion"]);
  assert.equal(tokens.color.accentSecondary, "#FF007A");
  assert.equal(tokens.color.textMuted, "rgba(250, 250, 250, 0.74)");
  assert.equal(tokens.font.sans, '"PolySans Trial", system-ui, -apple-system, sans-serif');
});

test("renders all 48 roles per scheme as unsigned ARGB Int64, plus typed metrics and avatar order", () => {
  const swift = renderNativeTokens().get(swiftPath);
  const constants = new Map([...swift.matchAll(/static let (\w+): Int64 = 0x([0-9A-F]{8})/g)]
    .map((match) => [match[1], parseInt(match[2], 16)]));
  assert.deepEqual([...swift.matchAll(/^import (.+)$/gm)].map((match) => match[1]), ["Foundation"]);
  assert.equal(androidRoles.length, 48);
  for (const mode of ["light", "dark", "inCall"]) {
    assert.deepEqual(Object.keys(native.android[mode]).sort(), [...androidRoles].sort());
    for (const role of androidRoles) {
      assert.equal(constants.get(`android${capitalize(mode)}${capitalize(role)}`), native.android[mode][role]);
    }
  }
  assert.notEqual(native.android.inCall, native.android.dark);
  assert.deepEqual(native.android.inCall, native.android.dark);
  assert.equal(constants.get("androidLightSurfaceTint"), 0);
  assert.equal(constants.get("iosInCallLabelScrim"), 0xA3000000);
  assert.equal(constants.get("iosInCallTextSecondary"), 0xBDFAFAFA);
  assert.equal(constants.get("coral"), 0xFFF95F4A);
  for (const [name, value] of Object.entries(native.space)) {
    assert.ok(swift.includes(`static let ${name}: Double = ${value}\n`));
  }
  assert.ok(swift.includes("static let radiusTile: Double = 16\n"));
  const avatar = swift.match(/static let avatarPalette: \[Int64\] = \[([^\]]+)\]/)[1]
    .split(", ").map((value) => Number(value));
  assert.deepEqual(avatar, [...native.avatar.palette]);
  assert.equal(avatar.length, 16);
  assert.equal(constants.get("avatarRing"), 0x2EFFFFFF);
  assert.doesNotMatch(swift, /accentSecondary|PolySans|SwiftUI|UIKit/);
});

function assetColors(json) {
  return JSON.parse(json).colors.map(({ appearances = [], color }) => ({
    appearances,
    rgb: ["red", "green", "blue"].map((channel) => color.components[channel].slice(2)).join(""),
    alpha: Number(color.components.alpha),
  }));
}

test("asset catalogs encode all four coral appearances and platform-specific launch colors", () => {
  const outputs = renderNativeTokens();
  assert.deepEqual(assetColors(outputs.get(`${assetsPath}/AccentColor.colorset/Contents.json`)), [
    { appearances: [], rgb: "B94333", alpha: 1 },
    { appearances: [{ appearance: "luminosity", value: "dark" }], rgb: "FF7D66", alpha: 1 },
    { appearances: [{ appearance: "contrast", value: "high" }], rgb: "9E3024", alpha: 1 },
    { appearances: [{ appearance: "luminosity", value: "dark" }, { appearance: "contrast", value: "high" }], rgb: "FF8C75", alpha: 1 },
  ]);
  assert.deepEqual(assetColors(outputs.get(`${assetsPath}/LaunchBackground.colorset/Contents.json`)).map((color) => color.rgb), ["F2F2F7", "000000"]);
  for (const [folder, value] of [["values", "FFFFFFFF"], ["values-night", "FF0A0A0B"]]) {
    const xml = outputs.get(`${resourcesPath}/${folder}/colors.xml`);
    assert.deepEqual([...xml.matchAll(/<color name="([^"]+)">([^<]+)<\/color>/g)]
      .map((match) => [match[1], match[2]]), [["conclave_window_background", `#${value}`]]);
    assert.doesNotMatch(xml, /md_theme|acm_|FF007A|884FF5/);
  }
});

test("rendering is independent of source key order and propagates actual token changes", () => {
  function reordered(value) {
    if (Array.isArray(value)) return value.map(reordered);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse()
      .map(([key, child]) => [key, reordered(child)]));
    return value;
  }
  assert.deepEqual(renderNativeTokens(reordered(native)), renderNativeTokens());
  const fixture = structuredClone(native);
  fixture.android.light.background = 0xFF112233;
  fixture.ios.app.coralTextLight = 0xFF445566;
  fixture.space.space4 = 4.5;
  const outputs = renderNativeTokens(fixture);
  assert.match(outputs.get(swiftPath), /androidLightBackground: Int64 = 0xFF112233/);
  assert.match(outputs.get(swiftPath), /space4: Double = 4.5/);
  assert.match(outputs.get(`${resourcesPath}/values/colors.xml`), /#FF112233/);
  assert.equal(assetColors(outputs.get(`${assetsPath}/AccentColor.colorset/Contents.json`))[0].rgb, "445566");
});

test("generation is deterministic and matching check/generate never rewrite files", async (t) => {
  const root = await tempRoot(t);
  assert.equal((await generateNativeTokens({ outputRoot: root })).drift.length, 5);
  const before = await snapshot(root);
  assert.deepEqual(await generateNativeTokens({ outputRoot: root }), { drift: [], outputCount: 5 });
  assert.deepEqual(await generateNativeTokens({ outputRoot: root, check: true }), { drift: [], outputCount: 5 });
  assert.deepEqual(await snapshot(root), before);
});

test("CLI check detects edited and missing output with nonzero exit and no writes", async (t) => {
  const root = await tempRoot(t);
  await generateNativeTokens({ outputRoot: root });
  const good = spawnSync(process.execPath, [script, "--check", "--output-root", root], { encoding: "utf8" });
  assert.equal(good.status, 0, good.stderr);
  await writeFile(join(root, swiftPath), "// deliberately stale fixture\n");
  await unlink(join(root, `${assetsPath}/AccentColor.colorset/Contents.json`));
  const before = await snapshot(root);
  const bad = spawnSync(process.execPath, [script, "--check", "--output-root", root], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Native token drift/);
  assert.ok(bad.stderr.includes(swiftPath));
  assert.match(bad.stderr, /AccentColor.colorset/);
  assert.deepEqual(await snapshot(root), before);
});

test("check on a missing output root does not create directories", async (t) => {
  const root = join(await tempRoot(t), "missing");
  const result = await generateNativeTokens({ outputRoot: root, check: true });
  assert.equal(result.drift.length, 5);
  await assert.rejects(stat(root), { code: "ENOENT" });
});

test("malformed token input fails before changing any output", async (t) => {
  const root = await tempRoot(t);
  await generateNativeTokens({ outputRoot: root });
  const before = await snapshot(root);
  const cases = [
    ["missing M3 role", (x) => { delete x.android.dark.primary; }, /native.android.dark.*missing \[primary\]/],
    ["misspelled role", (x) => { x.android.light.surfaec = 1; }, /unexpected \[surfaec\]/],
    ["missing section", (x) => { delete x.ios; }, /native: missing \[ios\]/],
    ["null section", (x) => { x.brand = null; }, /native.brand must be an object/],
    ["string color", (x) => { x.brand.coral = "#F95F4A"; }, /native.brand.coral.*ARGB integer/],
    ["negative color", (x) => { x.brand.coral = -1; }, /native.brand.coral.*ARGB integer/],
    ["color overflow", (x) => { x.brand.coral = 0x100000000; }, /native.brand.coral.*ARGB integer/],
    ["fractional color", (x) => { x.brand.coral = 1.5; }, /native.brand.coral.*ARGB integer/],
    ["NaN color", (x) => { x.brand.coral = NaN; }, /native.brand.coral.*ARGB integer/],
    ["nonfinite metric", (x) => { x.space.space4 = Infinity; }, /native.space.space4.*positive metric/],
    ["negative metric", (x) => { x.radius.tile = -4; }, /native.radius.tile.*positive metric/],
    ["short palette", (x) => { x.avatar.palette.pop(); }, /must contain 16/],
    ["sparse palette", (x) => { delete x.avatar.palette[3]; }, /native.avatar.palette\[3\].*ARGB integer/],
    ["invalid ring", (x) => { x.avatar.ring = undefined; }, /native.avatar.ring.*ARGB integer/],
  ];
  for (const [name, mutate, error] of cases) {
    await t.test(name, async () => {
      const fixture = structuredClone(native);
      mutate(fixture);
      await assert.rejects(generateNativeTokens({ outputRoot: root, tokens: fixture }), error);
      assert.deepEqual(await snapshot(root), before);
    });
  }
});
