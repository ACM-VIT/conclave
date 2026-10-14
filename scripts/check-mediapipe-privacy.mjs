#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { evaluate } from "./quality/cdp.mjs";
import {
  closeSilentBrowser,
  launchSilentBrowser,
  navigateSilentBrowserPage,
} from "./quality/silent-browser-contract.mjs";

const root = resolve(import.meta.dirname, "..");
const sdkRoot = resolve(root, "node_modules/@mediapipe/tasks-vision");
const bundles = ["vision_bundle.mjs", "vision_bundle.cjs", "vision_bundle.js"];
const disabledLogger =
  "function(t){/* Conclave: optional metrics logger disabled. */t.o=void 0}(t)";
const model = resolve(
  root,
  "apps/web/public/mediapipe/models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite",
);
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>MediaPipe privacy check</title>");
    return;
  }
  const bundle = url.pathname.replace("/sdk/", "");
  if (bundles.includes(bundle)) {
    let source = readFileSync(resolve(sdkRoot, bundle), "utf8");
    if (url.searchParams.has("control")) {
      // Restore upstream initialization only for the negative control. All
      // reporting requests are intercepted below before they leave Chrome.
      const logger = bundle.endsWith(".js") ? "Bh" : "Uh";
      source = source.replace(
        disabledLogger,
        `function(t,e){e=e.runningMode??"";var r=t.h.Ta();t.o=new ${logger}(t.D(),e,r)}(t,n)`,
      );
    }
    response.setHeader("Content-Type", "application/javascript");
    response.end(source);
    return;
  }
  if (/^\/wasm\/vision_wasm_[a-z_]+\.(js|wasm)$/.test(url.pathname)) {
    response.setHeader(
      "Content-Type",
      url.pathname.endsWith(".wasm")
        ? "application/wasm"
        : "application/javascript",
    );
    response.end(readFileSync(resolve(sdkRoot, `.${url.pathname}`)));
    return;
  }
  if (url.pathname === "/model.tflite") {
    response.end(readFileSync(model));
    return;
  }
  response.writeHead(404).end();
});

if (!isMainThread) {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  parentPort.postMessage(server.address().port);
} else {
  // Browser authority checks can block the driving thread. Keep HTTP responses
  // on a separate event loop so navigation never waits on the driver itself.
  const serverWorker = new Worker(new URL(import.meta.url));
  const port = await new Promise((done, reject) => {
    serverWorker.once("message", done);
    serverWorker.once("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  let browser;
  let probeError;
  try {
    browser = await launchSilentBrowser({
      chromePath:
        process.env.CHROME_PATH ??
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      label: "mediapipe-privacy",
    });
    const cdp = browser.pageCdp;
    for (const bundle of bundles) {
      for (const control of [true, false]) {
        console.info(
          `Checking ${bundle} (${control ? "upstream control" : "patched"})`,
        );
        await navigateSilentBrowserPage(browser, {
          url: baseUrl,
          label: "synthetic MediaPipe segmentation",
        });
        const { maskCount, reports } = await evaluate(
          cdp,
          `
        (async () => {
          const reports = [];
          const originalFetch = globalThis.fetch.bind(globalThis);
          globalThis.fetch = (input, options) => {
            const target = typeof input === "string" ? input : input.url ?? String(input);
            if (new URL(target, location.href).origin === "https://odml.pa.googleapis.com") {
              reports.push(target);
              return Promise.resolve(new Response("", { status: 200 }));
            }
            return originalFetch(input, options);
          };
          const bundle = ${JSON.stringify(bundle)};
          const url = "/sdk/" + bundle + ${JSON.stringify(control ? "?control=1" : "")};
          let sdk;
          if (bundle.endsWith(".mjs")) sdk = await import(url);
          else if (bundle.endsWith(".cjs")) {
            const module = { exports: {} };
            new Function("module", "exports", await (await fetch(url)).text())(module, module.exports);
            sdk = module.exports;
          } else {
            await new Promise((done, reject) => {
              const script = document.createElement("script");
              script.src = url;
              script.onload = done;
              script.onerror = reject;
              document.head.append(script);
            });
            sdk = window.Vision;
          }
          const fileset = await sdk.FilesetResolver.forVisionTasks("/wasm");
          const task = await sdk.ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: "/model.tflite", delegate: "CPU" },
            runningMode: "VIDEO",
            outputConfidenceMasks: true,
          });
          let maskCount;
          try {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 64;
            canvas.getContext("2d").fillRect(0, 0, 64, 64);
            maskCount = await new Promise((done) => task.segmentForVideo(canvas, 1,
              (result) => done(result.confidenceMasks.length)));
          } finally { task.close(); }
          await new Promise((done) => setTimeout(done, 250));
          return { maskCount, reports: reports.length };
        })()
      `,
          30_000,
        );
        assert.ok(
          maskCount > 0,
          "Real WASM inference must produce segmentation masks",
        );
        if (control)
          assert.ok(
            reports > 0,
            `${bundle}: upstream control must attempt reporting`,
          );
        else
          assert.equal(
            reports,
            0,
            `${bundle}: patched inference must not report metrics`,
          );
        console.log(
          JSON.stringify({
            bundle,
            control,
            maskCount,
            reportingAttempts: reports,
          }),
        );
      }
    }
  } catch (error) {
    probeError = error;
    console.error(error);
    throw error;
  } finally {
    try {
      await closeSilentBrowser(browser);
    } catch (error) {
      if (!probeError) throw error;
      console.error("Browser cleanup also failed:", error);
    } finally {
      await serverWorker.terminate();
    }
  }
}
