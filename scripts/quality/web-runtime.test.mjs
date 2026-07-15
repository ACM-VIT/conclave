import assert from "node:assert/strict";
import test from "node:test";
import { detectNextWebRuntime } from "./web-runtime.mjs";

test("detects Next development and production assets", () => {
  assert.equal(
    detectNextWebRuntime(
      '<script src="/_next/static/chunks/browser_dev_hmr-client.js"></script>',
    ),
    "development",
  );
  assert.equal(
    detectNextWebRuntime(
      '<script src="/_next/static/chunks/4bd1b696.js"></script>',
    ),
    "production",
  );
  assert.equal(detectNextWebRuntime("<html></html>"), "unknown");
});
