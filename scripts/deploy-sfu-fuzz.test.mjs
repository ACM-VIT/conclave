import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { cutRooms, deploy, withSfus } from "./test-support/deploy-harness.mjs";

const TARGET = "sha256:target";
const LAST_GOOD = "sha256:running";
const ONLY_A = { SFU_DEPLOY_SERVICES: "sfu-a" };

const sharedDir = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deploy-fuzz-"));
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

const journal = async (shared, name) => JSON.parse(await readFile(path.join(shared.env.SFU_DEPLOY_STATE_DIR, `vm.${name}.journal.json`), "utf8").catch(() => "{}"));

const withStack = (specs, body) =>
  withSfus(specs, async (sfus, events, context) => {
    const shared = await sharedDir();
    context.stateDir = shared.env.SFU_DEPLOY_STATE_DIR;
    try {
      await body(sfus, shared);
    } finally {
      await rm(shared.dir, { recursive: true, force: true });
    }
  });

const assertServes = (sfu, image) => {
  assert.equal(sfu.container, "running", `${sfu.instanceId} runs`);
  assert.equal(sfu.draining, false, `${sfu.instanceId} takes meetings`);
  assert.equal(sfu.image, image, `${sfu.instanceId} runs ${image}`);
};

const queued = [];
const fixed = (...args) => queued.push(args);

fixed("Neon 1: a promoted build whose container exits at boot goes back to its last-known-good image without waiting out a drain", () =>
  withStack({ "sfu-a": { onRecreate: (sfu) => sfu.image === TARGET && !sfu.bootDrained && (sfu.container = "exited") }, "sfu-b": {} }, async (sfus, shared) => {
    const result = await deploy(sfus, { env: { ...shared.env, ...ONLY_A } });
    assert.equal(result.code, 4, result.output);
    assertServes(sfus["sfu-a"], LAST_GOOD);
    assert.deepEqual(cutRooms(sfus), cutRooms(sfus).map(() => 0));
  }),
);

fixed("Neon 1: a promoted build whose drain is refused is never recreated while it takes meetings", () => {
  const failOnce = (sfu) => {
    if (sfu.image !== TARGET || sfu.bootDrained || sfu.failed) return;
    sfu.failed = true;
    sfu.publicDown = true;
    sfu.refuseDrain = true;
  };
  return withStack({ "sfu-a": { publicRoute: true, onRecreate: failOnce }, "sfu-b": {} }, async (sfus, shared) => {
    const result = await deploy(sfus, { env: { ...shared.env, ...ONLY_A } });
    assert.equal(result.code, 5, result.output);
    const undrained = sfus["sfu-a"].recreates.filter((recreate) => recreate.from === TARGET && !recreate.bootDrained && !recreate.draining);
    assert.deepEqual(undrained, [], "no recreate of the promoted build while it took meetings");
    assert.equal((await journal(shared, "sfu-a")).phase, "rollback");
  });
});

fixed("Neon 2: repair that finishes a promotion drains and waits for a call before it rolls back, and journals the rollback first", () => {
  let armed = false;
  const joinAndFail = (sfu) => {
    if (!armed || sfu.image !== TARGET || sfu.bootDrained) return;
    armed = false;
    sfu.rooms = 1;
    sfu.publicDown = true;
  };
  return withStack({ "sfu-a": { publicRoute: true, onRecreate: joinAndFail }, "sfu-b": {} }, async (sfus, shared) => {
    const crashed = await deploy(sfus, { env: { ...shared.env, ...ONLY_A, SFU_DEPLOY_TEST_CRASH_AT: "tag sfu-a" } });
    assert.equal(crashed.code, null, crashed.output);
    armed = true;
    const paused = await deploy(sfus, { env: { ...shared.env, ...ONLY_A } });
    assert.equal(paused.code, 3, paused.output);
    assert.equal(sfus["sfu-a"].rooms, 1, "the call is still on it");
    assert.equal((await journal(shared, "sfu-a")).phase, "rollback");
    sfus["sfu-a"].rooms = 0;
    sfus["sfu-a"].publicDown = false;
    const finished = await deploy(sfus, { env: { ...shared.env, ...ONLY_A } });
    assert.equal(finished.code, 0, finished.output);
    assertServes(sfus["sfu-a"], TARGET);
    assert.deepEqual(cutRooms(sfus), cutRooms(sfus).map(() => 0));
    const rollbacks = sfus["sfu-a"].recreates.filter((recreate) => recreate.to === LAST_GOOD && recreate.from !== LAST_GOOD);
    assert.ok(rollbacks.length > 0, "it was rolled back once the call ended");
    assert.deepEqual(rollbacks.map((recreate) => recreate.phase), rollbacks.map(() => "rollback"));
  });
});

fixed("Neon 3: a single instance whose promotion failed under a call is never put back into rotation on that build", () => {
  const joinAndFail = (sfu) => {
    if (sfu.image !== TARGET || sfu.bootDrained || sfu.failed) return;
    sfu.failed = true;
    sfu.rooms = 1;
    sfu.publicDown = true;
  };
  return withStack({ "sfu-a": { publicRoute: true, onRecreate: joinAndFail } }, async (sfus, shared) => {
    const paused = await deploy(sfus, { env: shared.env });
    assert.equal(paused.code, 3, paused.output);
    const again = await deploy(sfus, { env: shared.env });
    assert.equal(again.code, 3, again.output);
    assert.equal(sfus["sfu-a"].draining, true, "the failed build stays out of rotation");
    assert.deepEqual(sfus["sfu-a"].undrains.filter((undrain) => undrain.image !== undrain.lkg || !["idle", "drained", undefined].includes(undrain.phase)), []);
    assert.deepEqual(cutRooms(sfus), cutRooms(sfus).map(() => 0));
  });
});

fixed("Neon 4: repair keeps a drained instance's journal while its /status cannot be read, and undoes the drain once it can", () =>
  withStack({ "sfu-a": {}, "sfu-b": {} }, async (sfus, shared) => {
    const crashed = await deploy(sfus, { env: { ...shared.env, ...ONLY_A, SFU_DEPLOY_TEST_CRASH_AT: "drain sfu-a" } });
    assert.equal(crashed.code, null, crashed.output);
    sfus["sfu-a"].statusAnswers = false;
    const unreadable = await deploy(sfus, { env: { ...shared.env, ...ONLY_A } });
    assert.notEqual(unreadable.code, 0, unreadable.output);
    assert.equal((await journal(shared, "sfu-a")).phase, "drained");
    assert.equal((await journal(shared, "sfu-a")).wasDraining, "false");
    sfus["sfu-a"].statusAnswers = true;
    const other = await deploy(sfus, { env: { ...shared.env, SFU_DEPLOY_SERVICES: "sfu-b" } });
    assert.equal(other.code, 0, other.output);
    assertServes(sfus["sfu-a"], LAST_GOOD);
    assertServes(sfus["sfu-b"], TARGET);
  }),
);

fixed("Neon 6: an instance whose SFU_INSTANCE_ID is not its service name is shown to serve through its public URL", () =>
  withStack({ "sfu-a": { id: "eu-1", publicRoute: true }, "sfu-b": { id: "eu-2", publicRoute: true } }, async (sfus, shared) => {
    const result = await deploy(sfus, { env: shared.env });
    assert.equal(result.code, 0, result.output);
    assertServes(sfus["sfu-a"], TARGET);
    assertServes(sfus["sfu-b"], TARGET);
  }),
);

fixed("fuzz: a public route that is down when the deploy first looks still leaves the image the instance served on to go back to", () =>
  withStack({ "sfu-a": { publicRoute: true } }, async (sfus, shared) => {
    sfus["sfu-a"].publicFailures = 1;
    const result = await deploy(sfus, { env: { ...shared.env, DEPLOY_TEST_BAD_IMAGES: TARGET } });
    assert.equal(result.code, 4, result.output);
    assertServes(sfus["sfu-a"], LAST_GOOD);
  }),
);

describe("deploy-sfu.sh recovery", { concurrency: 6 }, () => {
  for (const args of queued) test(...args);
});
