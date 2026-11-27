import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { composeUpByHand, deploy, withSfus } from "./test-support/deploy-harness.mjs";

// Kills a deploy at every step boundary deploy-sfu.sh passes (each journal
// write, drain, tag and compose start), then lets the next deploy run, and
// checks that it always ends with every instance serving: on its last-known-
// good image, or on a build that passed its canary. A build that failed its
// canary never serves, not after a retry, a hand-run `docker compose up` or a
// second deploy that was already waiting on the lock.

const GOOD = "sha256:target";
const LAST_GOOD = "sha256:running";

// Two idle instances serving the last good image. The deploy moves sfu-a;
// sfu-b is the peer that must keep serving while sfu-a is drained. sfu-b's
// own steps are the same ones in the same order, so they are not run again.
const specs = () => ({ "sfu-a": {}, "sfu-b": {} });
const bothDrained = () => ({ "sfu-a": { draining: true }, "sfu-b": { draining: true } });
const ONLY_A = { SFU_DEPLOY_SERVICES: "sfu-a" };

const scenarios = {
  // The build passes its canary.
  passes: { title: "build passes its canary", env: ONLY_A, finalCode: 0, allowed: [LAST_GOOD, GOOD], finalImages: { "sfu-a": GOOD, "sfu-b": LAST_GOOD } },
  // The build fails its canary.
  fails: { title: "build fails its canary", env: { ...ONLY_A, DEPLOY_TEST_BAD_IMAGES: GOOD }, finalCode: 4, allowed: [LAST_GOOD], finalImages: { "sfu-a": LAST_GOOD, "sfu-b": LAST_GOOD } },
  firstUpgrade: {
    title: "first upgrade with every instance left drained, build passes its canary",
    specs: bothDrained,
    env: { ...ONLY_A, DEPLOY_TEST_UNTAGGED_SERVICE_BUILDS: "1" },
    finalCode: 0,
    allowed: [LAST_GOOD, GOOD],
    finalImages: { "sfu-a": GOOD, "sfu-b": LAST_GOOD },
  },
};

const sharedDir = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deploy-crash-"));
  return {
    dir,
    env: {
      SFU_DEPLOY_STATE_DIR: path.join(dir, "state"),
      DEPLOY_TEST_DOCKER_TAGS: path.join(dir, "tags.json"),
      SFU_DEPLOY_LOCK_FILE: path.join(dir, "deploy.lock"),
      SFU_DEPLOY_LOCK_WAIT_SECONDS: "60",
    },
  };
};

const steps = async (log) => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);

// Every instance serves, by what the fake SFU knows of itself: its container
// runs, did not boot drained, is healthy and takes meetings, on an allowed image.
const assertServing = (sfus, allowed, label) => {
  for (const [name, sfu] of Object.entries(sfus)) {
    const images = Array.isArray(allowed) ? allowed : [allowed[name]];
    assert.equal(sfu.container, "running", `${label}: ${name} runs`);
    assert.equal(sfu.draining, false, `${label}: ${name} takes meetings`);
    assert.equal(sfu.bootDrained, false, `${label}: ${name} did not boot drained`);
    assert.ok(images.includes(sfu.image), `${label}: ${name} runs ${sfu.image}, which is not one of ${images.join(", ")}`);
  }
};

// How many step boundaries a whole deploy of this scenario passes.
const countSteps = async (scenario) => {
  let count = 0;
  await withSfus((scenario.specs ?? specs)(), async (sfus) => {
    const shared = await sharedDir();
    try {
      const log = path.join(shared.dir, "steps.log");
      const result = await deploy(sfus, { env: { ...shared.env, ...scenario.env, SFU_DEPLOY_TEST_STEP_LOG: log } });
      assert.equal(result.code, scenario.finalCode, result.output);
      count = (await steps(log)).length;
    } finally {
      await rm(shared.dir, { recursive: true, force: true });
    }
  });
  return count;
};

const counts = {};
for (const [name, scenario] of Object.entries(scenarios)) counts[name] = await countSteps(scenario);

const crashAt = async (name, step, variant) => {
  const scenario = scenarios[name];
  await withSfus((scenario.specs ?? specs)(), async (sfus) => {
    const shared = await sharedDir();
    try {
      const log = path.join(shared.dir, "steps.log");
      const crashing = { ...shared.env, ...scenario.env, SFU_DEPLOY_TEST_STEP_LOG: log, SFU_DEPLOY_TEST_CRASH_AT_STEP: String(step) };
      let next;
      if (variant === "waiting") {
        // A second deploy starts while the first holds the lock, and takes
        // over the moment the first one dies.
        const first = deploy(sfus, { env: crashing });
        for (let i = 0; i < 400 && !(await steps(log)).length; i += 1) await new Promise((done) => setTimeout(done, 25));
        next = deploy(sfus, { env: { ...shared.env, ...scenario.env } });
        const crashed = await first;
        assert.equal(crashed.code, null, `the first deploy dies at step ${step}:\n${crashed.output}`);
        next = await next;
      } else {
        const crashed = await deploy(sfus, { env: crashing });
        assert.equal(crashed.code, null, `the deploy dies at step ${step}:\n${crashed.output}`);
        if (variant === "by hand" && (await steps(log)).some((line) => !/^\d+ lock held$/.test(line))) {
          // An operator restarts every instance with plain compose: each comes
          // up on what its own image name points at.
          for (const service of Object.keys(sfus)) {
            await composeUpByHand(sfus, { tags: shared.env.DEPLOY_TEST_DOCKER_TAGS, dir: path.join(shared.dir, "by-hand"), env: scenario.env }, service);
          }
          assertServing(sfus, scenario.allowed, `after a hand-run compose up, crash at step ${step}`);
        }
        next = await deploy(sfus, { env: { ...shared.env, ...scenario.env } });
      }
      assert.equal(next.code, scenario.finalCode, `the deploy after a crash at step ${step}:\n${next.output}`);
      assertServing(sfus, scenario.finalImages, `after the next deploy, crash at step ${step}`);
    } finally {
      await rm(shared.dir, { recursive: true, force: true });
    }
  });
};

describe("a deploy killed at any step", { concurrency: 8 }, () => {
  for (const [name, variants] of [["passes", ["retried"]], ["fails", ["by hand", "waiting"]], ["firstUpgrade", ["by hand"]]]) {
    for (const variant of variants) {
      for (let step = 1; step <= counts[name]; step += 1) {
        test(`${scenarios[name].title}, killed at step ${step} of ${counts[name]}, then ${variant}`, () => crashAt(name, step, variant));
      }
    }
  }
});
