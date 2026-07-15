import assert from "node:assert/strict";
import test from "node:test";
import {
  assessSilentBrowserLifecycle,
  closeBrowsersWithLifecycleEvidence,
  summarizeSilentBrowserStart,
} from "./silent-browser-evidence.mjs";

const silentSnapshot = (overrides = {}) => ({
  safe: true,
  immutableGuardsIntact: true,
  captureGuardsIntact: true,
  trustedBootstrapsIntact: true,
  trustedCaptureAuditIntact: true,
  trustedSyntheticZeroAudioConfigured: true,
  zeroAudioOnly: true,
  hardwareCaptureAllowed: false,
  ...overrides,
});

const browser = (label, childPid) => ({
  label,
  silentAuthority: {
    childPid,
    exactHeadless: true,
    muted: true,
    zeroAudioInput: true,
    isolatedProfile: true,
    runningArguments: ["--headless=new", "--mute-audio"],
    silentAudioFixture: { path: "/private/sensitive-zero.wav" },
  },
  silentBootstrap: silentSnapshot(),
  navigationSafety: silentSnapshot(),
});

const cleanResult = (label) => ({
  label,
  finalAttestation: { ok: true, snapshot: silentSnapshot() },
  processTerminated: true,
  profileRemoved: true,
  cleanupAuthorityRetained: false,
});

test("start evidence proves silence without leaking launch arguments or fixture paths", () => {
  const evidence = summarizeSilentBrowserStart(browser("publisher", 4242));
  assert.equal(evidence.safe, true);
  assert.deepEqual(evidence.authority, {
    childPid: 4242,
    exactHeadless: true,
    muted: true,
    zeroAudioInput: true,
    isolatedProfile: true,
    stdioPolicy: "ignored",
  });
  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /runningArguments/);
  assert.doesNotMatch(serialized, /sensitive-zero/);
});

test("lifecycle evidence is safe only after final attestation and proven cleanup", async () => {
  const browsers = [browser("publisher", 4242), browser("viewer", 4243)];
  const closeOrder = [];
  const lifecycle = await closeBrowsersWithLifecycleEvidence(browsers, {
    closeBrowserImpl: async (entry) => {
      closeOrder.push(entry.label);
      return cleanResult(entry.label);
    },
    sleepImpl: async () => {},
  });
  assert.deepEqual(closeOrder, ["viewer", "publisher"]);
  assert.equal(lifecycle.browserCount, 2);
  assert.equal(lifecycle.safe, true);
  assert.equal(lifecycle.finalAttestationsPassed, true);
  assert.equal(lifecycle.processesTerminated, true);
  assert.equal(lifecycle.profilesRemoved, true);
  assert.equal(lifecycle.cleanupAuthorityReleased, true);
});

test("cleanup retries retained authority and remains invalid when death is unproven", async () => {
  const target = browser("publisher", 4242);
  let attempts = 0;
  const lifecycle = await closeBrowsersWithLifecycleEvidence([target], {
    closeBrowserImpl: async () => {
      attempts += 1;
      const error = new Error("Chrome process group survived SIGKILL");
      error.result = {
        label: target.label,
        finalAttestation: { ok: true, snapshot: silentSnapshot() },
        processTerminated: false,
        profileRemoved: false,
        cleanupAuthorityRetained: true,
      };
      throw error;
    },
    sleepImpl: async () => {},
  });
  assert.equal(attempts, 3);
  assert.equal(lifecycle.safe, false);
  assert.equal(lifecycle.processesTerminated, false);
  assert.equal(lifecycle.profilesRemoved, false);
  assert.equal(lifecycle.cleanupAuthorityReleased, false);
  assert.equal(lifecycle.cleanups[0].errors.length, 3);
});

test("a failed final page attestation invalidates otherwise complete cleanup", () => {
  const start = summarizeSilentBrowserStart(browser("viewer", 4243));
  const lifecycle = assessSilentBrowserLifecycle({
    starts: [start],
    cleanups: [
      {
        label: "viewer",
        finalAttestation: { ok: false, error: "guard changed" },
        processTerminated: true,
        profileRemoved: true,
        cleanupAuthorityReleased: true,
        safe: false,
      },
    ],
  });
  assert.equal(lifecycle.safe, false);
  assert.equal(lifecycle.finalAttestationsPassed, false);
  assert.equal(lifecycle.processesTerminated, true);
});

test("an empty or incomplete browser set can never pass by vacuous truth", async () => {
  const empty = await closeBrowsersWithLifecycleEvidence([], {
    expectedBrowserCount: 2,
    closeBrowserImpl: async () => {
      throw new Error("no browser should be closed");
    },
  });
  assert.equal(empty.browserCount, 0);
  assert.equal(empty.expectedBrowserCount, 2);
  assert.equal(empty.complete, false);
  assert.equal(empty.safe, false);
  assert.equal(empty.exactHeadless, false);
  assert.equal(empty.processesTerminated, false);
  assert.equal(empty.profilesRemoved, false);
  assert.equal(empty.cleanupAuthorityReleased, false);

  const incomplete = assessSilentBrowserLifecycle({
    starts: [summarizeSilentBrowserStart(browser("publisher", 4242))],
    cleanups: [
      {
        label: "publisher",
        finalAttestation: { ok: true, snapshot: silentSnapshot() },
        processTerminated: true,
        profileRemoved: true,
        cleanupAuthorityReleased: true,
        safe: true,
      },
    ],
    expectedBrowserCount: 2,
  });
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.safe, false);
  assert.equal(incomplete.processesTerminated, true);
  assert.equal(incomplete.profilesRemoved, true);
  assert.equal(incomplete.cleanupAuthorityReleased, true);
});
