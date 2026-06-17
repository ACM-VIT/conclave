#!/usr/bin/env node
/**
 * Web join smoke test — standalone, does NOT import or edit apps/web source.
 *
 * Goal: confirm the apps/web client boots and reaches the pre-join phase
 * against an *already-running* `next dev` (default http://localhost:3000).
 *
 * Two tiers, picked automatically:
 *   1. Browser tier (preferred) — if `playwright-core` resolves and a system
 *      Chrome is found, it drives a real headless browser (fake media devices),
 *      walks the guest path (Get started -> name -> Continue as guest), and
 *      asserts the join UI rendered. This is the real "join smoke".
 *   2. HTTP tier (fallback) — fetches `/` and asserts the Next app shell is
 *      served (HTML, <html, has the app root). Catches "server is up but the
 *      app 500s / serves the wrong thing".
 *
 * SKIP semantics (exit 0): if the dev server is unreachable, the smoke skips
 * rather than fails, so it never breaks CI where no server is booted. Set
 * `WEB_JOIN_SMOKE_REQUIRE=1` to make an unreachable server a hard failure.
 *
 * Env:
 *   WEB_BASE_URL          base url (default http://localhost:3000)
 *   WEB_JOIN_SMOKE_REQUIRE  "1" -> unreachable server is a failure, not a skip
 *   CHROME_PATH           explicit Chrome/Chromium executable path
 */

import { existsSync } from "node:fs";

const BASE_URL = (process.env.WEB_BASE_URL || "http://localhost:3000").replace(
  /\/$/,
  "",
);
const REQUIRE = process.env.WEB_JOIN_SMOKE_REQUIRE === "1";

const log = (...a) => console.log("[web-join-smoke]", ...a);

function skip(reason) {
  if (REQUIRE) {
    console.error("[web-join-smoke] FAIL (required):", reason);
    process.exit(1);
  }
  log("SKIP:", reason);
  process.exit(0);
}

function pass(reason) {
  log("PASS:", reason);
  process.exit(0);
}

function fail(reason) {
  console.error("[web-join-smoke] FAIL:", reason);
  process.exit(1);
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal, redirect: "manual" });
  } finally {
    clearTimeout(t);
  }
}

async function serverReachable() {
  try {
    const res = await fetchWithTimeout(BASE_URL + "/", 4000);
    // Any HTTP response (even a redirect) means the server is up.
    return res.status > 0;
  } catch {
    return false;
  }
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  });
}

async function loadPlaywright() {
  // Resolve playwright-core from a few known locations without making it a hard
  // dependency of this package (keeps the repo install light).
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  for (const base of [
    "playwright-core",
    "/tmp/pw/node_modules/playwright-core/index.js",
  ]) {
    try {
      return req(base);
    } catch {
      /* try next */
    }
  }
  return null;
}

async function httpTier() {
  let res;
  try {
    res = await fetchWithTimeout(BASE_URL + "/", 8000);
  } catch (err) {
    return fail(`could not GET ${BASE_URL}/: ${err?.message || err}`);
  }
  if (res.status >= 500) {
    return fail(`server returned ${res.status} for /`);
  }
  const body = await res.text();
  const looksLikeApp =
    /<html/i.test(body) && (/__next/i.test(body) || /id="?__next/i.test(body) || /<body/i.test(body));
  if (!looksLikeApp) {
    return fail("response did not look like the Next app shell (no <html>/app root)");
  }
  pass(`HTTP tier — Next app shell served from ${BASE_URL} (status ${res.status})`);
}

async function browserTier(playwright) {
  const exe = findChrome();
  if (!exe) {
    log("no system Chrome found — falling back to HTTP tier");
    return httpTier();
  }

  let browser;
  try {
    browser = await playwright.chromium.launch({
      executablePath: exe,
      headless: true,
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--no-sandbox",
      ],
    });
  } catch (err) {
    log("Chrome launch failed — falling back to HTTP tier:", err?.message || err);
    return httpTier();
  }

  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded", timeout: 20000 });

    // Phase-adaptive: a signed-in session lands directly on join; a fresh guest
    // must click through. Read the live DOM text rather than assuming a phase.
    const text = async () => (await page.evaluate(() => document.body.innerText)) || "";

    const clickByText = async (re, timeout = 4000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const handle = await page.evaluateHandle((pattern) => {
          const rx = new RegExp(pattern, "i");
          const els = Array.from(
            document.querySelectorAll("button, a, [role=button]"),
          );
          return els.find((el) => rx.test(el.textContent || "")) || null;
        }, re.source);
        const el = handle.asElement();
        if (el) {
          await el.click().catch(() => {});
          return true;
        }
        await page.waitForTimeout(150);
      }
      return false;
    };

    // Guest walk-through (no-op if already on the join phase).
    if (/get started/i.test(await text())) {
      await clickByText(/get started/i);
      const nameInput = await page
        .waitForSelector("input", { timeout: 5000 })
        .catch(() => null);
      if (nameInput) await nameInput.fill("Smoke Tester");
      await clickByText(/continue as guest|continue|guest/i);
    }

    // Assert we reached a join-ish surface. The join phase shows controls to
    // create/join a meeting and/or a name + join affordance.
    const joinReady = await page
      .waitForFunction(
        () => {
          const t = (document.body.innerText || "").toLowerCase();
          return (
            /join/.test(t) ||
            /meeting/.test(t) ||
            /room code/.test(t) ||
            /new meeting/.test(t)
          );
        },
        { timeout: 12000 },
      )
      .then(() => true)
      .catch(() => false);

    if (!joinReady) {
      const sample = (await text()).slice(0, 200).replace(/\s+/g, " ");
      return fail(`never reached the join phase (page text: "${sample}")`);
    }
    pass(`browser tier — reached join phase at ${BASE_URL} via ${exe}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  log("base url:", BASE_URL, REQUIRE ? "(server required)" : "(skip if down)");
  if (!(await serverReachable())) {
    skip(`dev server not reachable at ${BASE_URL} (is "next dev" running?)`);
  }
  const playwright = await loadPlaywright();
  if (playwright) {
    await browserTier(playwright);
  } else {
    log("playwright-core not available — running HTTP tier");
    await httpTier();
  }
}

main().catch((err) => fail(err?.stack || String(err)));
