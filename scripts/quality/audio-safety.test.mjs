import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";

const read = (path) => readFileSync(resolve(path), "utf8");
const occurrences = (source, needle) => source.split(needle).length - 1;

test("every browser probe delegates Chrome authority to the silent contract", () => {
  const contract = read("scripts/quality/silent-browser-contract.mjs");
  assert.equal(occurrences(contract, '"--mute-audio"') >= 2, true);
  assert.match(contract, /"--headless=new"/);
  assert.match(contract, /stdio = Object\.freeze\(\["ignore", "ignore", "ignore"\]\)/);

  const launchers = [
    "scripts/probe-low-bandwidth-meet.mjs",
    "scripts/debug-video-effects-headless.mjs",
    "scripts/observe-meet-effects-headless.mjs",
    "scripts/quality/run-headless-video-quality.mjs",
  ];

  for (const path of launchers) {
    const source = read(path);
    assert.match(source, /launchSilentBrowser/);
    assert.match(source, /navigateSilentBrowserPage/);
    assert.doesNotMatch(source, /spawn\s*\(\s*chromePath/);
    assert.doesNotMatch(source, /\.send\("Page\.navigate"/);
  }
});

test("legacy browser probes are exact-headless, isolated, and output-suppressed", () => {
  const contract = read("scripts/quality/silent-browser-contract.mjs");
  const debugSource = read("scripts/debug-video-effects-headless.mjs");
  const observerSource = read("scripts/observe-meet-effects-headless.mjs");

  assert.match(contract, /AudioDestinationNode/);
  assert.match(contract, /speechSynthesis\?\.cancel\(\)/);
  assert.match(contract, /HTMLMediaElement/);
  assert.match(contract, /createConstantSource\(\)/);
  assert.match(contract, /source\.offset\.value = 0/);
  assert.match(contract, /gain\.gain\.value = 0/);
  assert.match(contract, /--use-file-for-fake-audio-capture=/);
  assert.match(contract, /non-zero PCM samples/);
  assert.doesNotMatch(contract, /createOscillator\(\)/);

  assert.match(debugSource, /cannot attach to a configured port/);
  assert.match(observerSource, /cannot attach to or select a browser port/);
  assert.match(observerSource, /cannot request native media capture/);
  assert.match(observerSource, /ephemeral centrally owned browser profile/);
});

test("quality runner is headless, doubly muted, and never unmutes", () => {
  const source = read("scripts/quality/run-headless-video-quality.mjs");
  const contract = read("scripts/quality/silent-browser-contract.mjs");
  const meetingSocket = read("apps/web/src/app/hooks/useMeetSocket.ts");
  assert.match(source, /launchSilentBrowser/);
  assert.match(
    source,
    new RegExp(["createTrustedQuality", "FixtureBootstrap"].join("")),
  );
  assert.match(source, /navigateSilentBrowserPage/);
  assert.match(source, /closeSilentBrowser/);
  assert.doesNotMatch(source, /spawn\s*\(\s*chromePath/);
  assert.doesNotMatch(source, /\.send\("Page\.navigate"/);
  assert.doesNotMatch(source, /remote-debugging-port/);
  assert.match(contract, /"--headless=new"/);
  assert.match(contract, /"--mute-audio"/);
  assert.match(contract, /AudioDestinationNode/);
  assert.match(contract, /speechSynthesis\?\.cancel\(\)/);
  assert.match(contract, /--use-file-for-fake-audio-capture=/);
  assert.match(contract, /stdio = Object\.freeze\(\["ignore", "ignore", "ignore"\]\)/);
  assert.ok(
    occurrences(source, "enableSyntheticAudio: true") >= 2,
    "publisher and viewer must both use synthetic audio",
  );
  assert.match(source, /getMediaCaptureAudit/);
  assert.match(source, /nativeAudioCallCount/);
  assert.doesNotMatch(source, /clickButton\([^\n]+["']Unmute["']/);
  assert.match(
    meetingSocket,
    /if \(!bypassMediaPermissions\) \{\s*primeAudioOutput\(\);\s*\}/,
  );
});

test("legacy low-bandwidth probes cannot synthesize an audible tone", () => {
  const source = read("scripts/probe-low-bandwidth-meet.mjs");
  const contract = read("scripts/quality/silent-browser-contract.mjs");
  assert.match(source, /launchSilentBrowser/);
  assert.match(contract, /AudioDestinationNode/);
  assert.match(contract, /createConstantSource\(\)/);
  assert.match(contract, /gain\.gain\.value = 0/);
  assert.doesNotMatch(source, /Unmute/);
  assert.doesNotMatch(source, /createOscillator\(\)/);
  assert.doesNotMatch(source, /frequency\.value\s*=\s*440/);
  assert.doesNotMatch(source, /gain\.gain\.value\s*=\s*0\.015/);
});
