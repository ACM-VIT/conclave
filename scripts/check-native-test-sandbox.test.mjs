import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileProblems, problems, ruleFile, sandboxSdks } from "./check-native-test-sandbox.mjs";

const rule = "    @get:Rule val urlHandlerSandbox = SharedUrlHandlerSandbox()";

function testClass({ config = "@Config(manifest = Config.NONE, sdk = [33])", body = "" } = {}) {
  return ["@RunWith(RobolectricTestRunner::class)", config, "class T {", body, "    @Test fun a() {}", "}"].join("\n");
}

test("every native Robolectric class off sdk 28 uses the shared URL handler rule", () => {
  assert.deepEqual(problems(), []);
});

test("an sdk 33 class without the rule fails", () => {
  assert.equal(fileProblems("T.kt", testClass()).length, 1);
});

test("an sdk 33 class with the rule passes", () => {
  assert.deepEqual(fileProblems("T.kt", testClass({ body: rule })), []);
});

test("an sdk 28 class needs no rule", () => {
  assert.deepEqual(fileProblems("T.kt", testClass({ config: "@Config(manifest = Config.NONE, sdk = [28])" })), []);
});

test("a class with no sdk runs on the default sdk and needs the rule", () => {
  assert.deepEqual(sandboxSdks(testClass({ config: "" })), ["default"]);
  assert.equal(fileProblems("T.kt", testClass({ config: "" })).length, 1);
});

test("a class that lists sdk 28 among others needs the rule", () => {
  assert.equal(fileProblems("T.kt", testClass({ config: "@Config(manifest = Config.NONE, sdk = [28, 33])" })).length, 1);
});

test("an sdk 28 class with a method on another sdk needs the rule", () => {
  const text = testClass({ config: "@Config(manifest = Config.NONE, sdk = [28])", body: "    @Test\n    @Config(sdk = [33])\n    fun b() {}" });
  assert.deepEqual(sandboxSdks(text), ["28", "33"]);
  assert.equal(fileProblems("T.kt", text).length, 1);
});

test("a method config without an sdk keeps the class sdk", () => {
  const text = testClass({ config: "@Config(manifest = Config.NONE, sdk = [28])", body: '    @Test @Config(qualifiers = "en-rXA") fun b() {}' });
  assert.deepEqual(sandboxSdks(text), ["28"]);
});

test("a hand reset of the URL handler fails outside the rule", () => {
  const reset = 'AssetURLProtocol::class.java.getDeclaredField("registered").apply { isAccessible = true }.setBoolean(null, true)';
  assert.equal(fileProblems("T.kt", testClass({ body: `${rule}\n    ${reset}` })).length, 1);
  assert.deepEqual(fileProblems(ruleFile, reset), []);
});

test("a plain JUnit class needs no rule", () => {
  assert.deepEqual(fileProblems("T.kt", "class T {\n    @Test fun a() {}\n}"), []);
});

test("the checker reads Kotlin test files under the given root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-test-sandbox-"));
  try {
    const dir = path.join(root, "apps/conclave-skip/Tests/ConclaveTests/Skip");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "Off.kt"), testClass());
    await writeFile(path.join(dir, "On.kt"), testClass({ body: rule }));
    assert.deepEqual(problems(root).map(({ file }) => path.basename(file)), ["Off.kt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
