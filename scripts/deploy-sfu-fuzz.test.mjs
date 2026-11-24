import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
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

fixed("a call that reaches a drained candidate pauses the deploy, and the next run promotes the build once the call ends", () => {
  const callOnce = (sfu) => {
    if (sfu.image !== TARGET || !sfu.bootDrained || sfu.called) return;
    sfu.called = true;
    sfu.rooms = 1;
  };
  return withStack({ "sfu-a": { onRecreate: callOnce }, "sfu-b": {} }, async (sfus, shared) => {
    const paused = await deploy(sfus, { env: { ...shared.env, ...ONLY_A } });
    assert.equal(paused.code, 3, paused.output);
    assert.equal((await journal(shared, "sfu-a")).phase, "passed");
    assert.equal(sfus["sfu-a"].draining, true);
    sfus["sfu-a"].rooms = 0;
    const finished = await deploy(sfus, { env: { ...shared.env, ...ONLY_A } });
    assert.equal(finished.code, 0, finished.output);
    assertServes(sfus["sfu-a"], TARGET);
    assert.equal((await journal(shared, "sfu-a")).phase, "idle");
    assert.deepEqual(cutRooms(sfus), cutRooms(sfus).map(() => 0));
  });
});

fixed("fuzz: a call on a drained candidate whose /status stops answering is never cut", () => {
  const callAndGoQuiet = (sfu) => {
    if (sfu.image !== TARGET || !sfu.bootDrained || sfu.called) return;
    sfu.called = true;
    sfu.rooms = 1;
    sfu.statusAnswers = false;
  };
  return withStack({ "sfu-a": { onRecreate: callAndGoQuiet }, "sfu-b": {} }, async (sfus, shared) => {
    const stuck = await deploy(sfus, { env: { ...shared.env, ...ONLY_A } });
    assert.equal(stuck.code, 5, stuck.output);
    assert.equal(sfus["sfu-a"].rooms, 1, "the call is still on it");
    assert.equal((await journal(shared, "sfu-a")).phase, "rollback");
    sfus["sfu-a"].statusAnswers = true;
    sfus["sfu-a"].rooms = 0;
    const finished = await deploy(sfus, { env: { ...shared.env, ...ONLY_A } });
    assert.equal(finished.code, 0, finished.output);
    assertServes(sfus["sfu-a"], TARGET);
    assert.deepEqual(cutRooms(sfus), cutRooms(sfus).map(() => 0));
  });
});

fixed("Greptile: a container that restarted and runs again is busy, so a call it took after the restart is waited for, not cut", () => {
  const restartUnderCall = (sfu) => {
    if (sfu.image !== TARGET || sfu.bootDrained || sfu.failed) return;
    sfu.failed = true;
    sfu.publicDown = true;
    sfu.rooms = 1;
    sfu.restartsWhileRunning = true;
  };
  return withStack({ "sfu-a": { publicRoute: true, onRecreate: restartUnderCall }, "sfu-b": {} }, async (sfus, shared) => {
    const paused = await deploy(sfus, { env: { ...shared.env, ...ONLY_A } });
    assert.equal(paused.code, 3, paused.output);
    assert.equal(sfus["sfu-a"].rooms, 1, "the call is still on it");
    assert.deepEqual(cutRooms(sfus), cutRooms(sfus).map(() => 0));
    assert.equal((await journal(shared, "sfu-a")).phase, "rollback");
  });
});

fixed("Greptile: a journal write that fails stops the deploy before the step it records", () => {
  let stateDir = "";
  const lockJournal = (sfu) => {
    if (sfu.image === TARGET && sfu.bootDrained && !sfu.locked) {
      sfu.locked = true;
      chmodSync(stateDir, 0o500);
    }
  };
  return withStack({ "sfu-a": { onRecreate: lockJournal }, "sfu-b": {} }, async (sfus, shared) => {
    stateDir = shared.env.SFU_DEPLOY_STATE_DIR;
    try {
      const result = await deploy(sfus, { env: { ...shared.env, ...ONLY_A } });
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, /could not write sfu-a's deploy journal/);
      assert.equal(sfus["sfu-a"].recreates.length, 1, "nothing changed after the failed write");
    } finally {
      chmodSync(stateDir, 0o700);
    }
  });
});

fixed("fuzz: a public route that is down when the deploy first looks still leaves the image the instance served on to go back to", () =>
  withStack({ "sfu-a": { publicRoute: true } }, async (sfus, shared) => {
    sfus["sfu-a"].publicFailures = 1;
    const result = await deploy(sfus, { env: { ...shared.env, DEPLOY_TEST_BAD_IMAGES: TARGET } });
    assert.equal(result.code, 4, result.output);
    assertServes(sfus["sfu-a"], LAST_GOOD);
  }),
);

const mulberry32 = (start) => {
  let seed = start;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const makePlan = (seed) => {
  const rand = mulberry32(seed);
  const chance = (p) => rand() < p;
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const names = chance(0.3) ? ["sfu-a"] : ["sfu-a", "sfu-b"];
  const window = () => ({ who: pick(names), atMs: Math.floor(rand() * 6000), ms: pick([400, 1500, 4000]) });
  return {
    seed,
    names,
    only: names.length === 2 && chance(0.4) ? "sfu-a" : null,
    canaryFails: chance(0.3),
    promotedExits: chance(0.15),
    candidateExits: chance(0.1),
    callOnCandidate: chance(0.15),
    routeDownAfterPromotion: chance(0.2) ? pick([400, 1500, 4000]) : 0,
    statusOutages: Array.from({ length: pick([0, 0, 1, 2]) }, window),
    routeOutages: Array.from({ length: pick([0, 0, 1]) }, window),
    drainRefusals: Array.from({ length: pick([0, 0, 0, 1]) }, window),
    statusOutageAfterRecreate: chance(0.2) ? { who: pick(names), ms: pick([400, 1500, 4000]) } : null,
    statusOutageAtRerun: chance(0.3) ? { who: pick(names), ms: pick([1500, 4000, 8000]) } : null,
    callRate: pick([0, 0, 0.05, 0.2]),
    callMs: pick([300, 1200, 3000]),
    crashes: [chance(0.85) ? 1 + Math.floor(rand() * 30) : 0, chance(0.35) ? 1 + Math.floor(rand() * 30) : 0],
  };
};

const settledPhase = (phase) => phase === undefined || phase === "" || phase === "idle";

const checkRun = async ({ sfus, shared, plan, result, label, quiet }) => {
  const allowed = plan.canaryFails ? [LAST_GOOD] : [LAST_GOOD, TARGET];
  const problems = [];
  for (const [name, sfu] of Object.entries(sfus)) {
    for (const cut of [...sfu.recreates, ...sfu.stops].filter((entry) => entry.roomsCut > 0)) problems.push(`${name}: ${cut.roomsCut} call(s) cut by a restart`);
    for (const undrain of sfu.undrains) {
      if (!["idle", "drained", undefined, ""].includes(undrain.phase) || (undrain.lkg && undrain.image !== undrain.lkg)) {
        problems.push(`${name}: undrained on ${undrain.image} while its journal said ${undrain.phase} with last-known-good ${undrain.lkg}`);
      }
    }
    for (const recreate of sfu.recreates) {
      if (recreate.lkg && recreate.to === recreate.lkg && recreate.from !== recreate.lkg && recreate.phase !== "rollback") {
        problems.push(`${name}: rolled back to ${recreate.to} while its journal said ${recreate.phase}, not rollback`);
      }
    }
    if (result.code !== null) {
      const { phase } = await journal(shared, name);
      if (!(sfu.container === "running" && allowed.includes(sfu.image)) && phase !== "rollback") {
        problems.push(`${name}: left ${sfu.container} on ${sfu.image} with its journal at ${phase}, so nothing serves and no rollback is under way`);
      }
      const serves = sfu.container === "running" && !sfu.draining && allowed.includes(sfu.image);
      if ((result.code === 0 && !(serves && settledPhase(phase))) || (result.code === 4 && !serves)) {
        problems.push(`${name}: exit ${result.code}, but it is ${sfu.container}, draining ${sfu.draining}, on ${sfu.image}, journal ${phase}`);
      }
    }
  }
  if (result.code === 3 && !quiet && !Object.values(sfus).some((sfu) => sfu.rooms > 0 || Date.now() - (sfu.lastCallAt ?? 0) < 8000)) {
    problems.push("paused for calls (exit 3) while no instance had any");
  }
  if (result.code === 3 && quiet) problems.push("paused for calls (exit 3) with no calls running");
  if (problems.length) {
    throw new Error(`seed ${plan.seed}, ${label}, exit ${result.code}:\n  ${problems.join("\n  ")}\nplan: ${JSON.stringify(plan)}\n--- output ---\n${result.output}`);
  }
};

const runPlan = async (plan) => {
  const hooks = { onRecreate: () => undefined };
  const specs = Object.fromEntries(plan.names.map((name) => [name, { publicRoute: true, onRecreate: (sfu) => hooks.onRecreate(sfu) }]));
  await withStack(specs, async (sfus, shared) => {
    const rand = mulberry32(plan.seed ^ 0x5eed);
    const timers = new Set();
    const later = (ms, fn) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        fn();
      }, ms);
      timers.add(timer);
    };
    const done = new Set();
    const once = (key) => !done.has(key) && done.add(key);
    const calls = [];
    const generation = (sfu) => sfu.recreates.length + sfu.stops.length;
    let faults = true;
    hooks.onRecreate = (sfu) => {
      if (!faults) return;
      if (sfu.image === TARGET && !sfu.bootDrained && plan.promotedExits && once("promotedExits")) sfu.container = "exited";
      if (sfu.image === TARGET && sfu.bootDrained && plan.candidateExits && once("candidateExits")) sfu.container = "exited";
      if (sfu.image === TARGET && sfu.bootDrained && sfu.container === "running" && plan.callOnCandidate && once("callOnCandidate")) {
        sfu.rooms += 1;
        calls.push({ sfu, generation: generation(sfu), endAt: Date.now() + plan.callMs });
      }
      if (sfu.image === TARGET && !sfu.bootDrained && plan.routeDownAfterPromotion && once("routeDown")) {
        sfu.publicDown = true;
        later(plan.routeDownAfterPromotion, () => (sfu.publicDown = false));
      }
      const outage = plan.statusOutageAfterRecreate;
      if (outage && outage.who === sfu.instanceId && once("statusAfterRecreate")) {
        sfu.statusAnswers = false;
        later(outage.ms, () => (sfu.statusAnswers = true));
      }
    };
    const windows = [
      ...plan.statusOutages.map((w) => [w, "statusAnswers", false]),
      ...plan.routeOutages.map((w) => [w, "publicDown", true]),
      ...plan.drainRefusals.map((w) => [w, "refuseDrain", true]),
    ];
    for (const [w, field, value] of windows) {
      later(w.atMs, () => {
        if (!faults) return;
        sfus[w.who][field] = value;
        later(w.ms, () => (sfus[w.who][field] = !value));
      });
    }
    const tick = setInterval(() => {
      const now = Date.now();
      for (const sfu of Object.values(sfus)) {
        for (const call of calls.filter((entry) => entry.sfu === sfu && entry.endAt <= now)) {
          calls.splice(calls.indexOf(call), 1);
          if (call.generation === generation(sfu)) sfu.rooms = Math.max(0, sfu.rooms - 1);
        }
        if (faults && plan.callRate && sfu.container === "running" && !sfu.draining && sfu.statusAnswers && rand() < plan.callRate) {
          sfu.rooms += 1;
          calls.push({ sfu, generation: generation(sfu), endAt: now + plan.callMs });
        }
        if (sfu.rooms > 0) sfu.lastCallAt = now;
      }
    }, 100);
    const env = {
      ...shared.env,
      HEALTH_TIMEOUT_SECONDS: "2",
      ...(plan.only ? { SFU_DEPLOY_SERVICES: plan.only } : {}),
      ...(plan.canaryFails ? { DEPLOY_TEST_BAD_IMAGES: TARGET } : {}),
    };
    try {
      for (const [index, crash] of plan.crashes.entries()) {
        if (index > 0 && plan.statusOutageAtRerun) {
          const sfu = sfus[plan.statusOutageAtRerun.who];
          sfu.statusAnswers = false;
          later(plan.statusOutageAtRerun.ms, () => (sfu.statusAnswers = true));
        }
        const result = await deploy(sfus, { env: { ...env, ...(crash ? { SFU_DEPLOY_TEST_CRASH_AT_STEP: String(crash) } : {}) } });
        await checkRun({ sfus, shared, plan, result, label: `run ${index + 1}${crash ? `, killed at step ${crash}` : ""}` });
      }
      faults = false;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      calls.length = 0;
      for (const sfu of Object.values(sfus)) Object.assign(sfu, { rooms: 0, statusAnswers: true, publicDown: false, refuseDrain: false });
      let result = null;
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        result = await deploy(sfus, { env });
        await checkRun({ sfus, shared, plan, result, label: `settling run ${attempt}`, quiet: true });
        if ([0, 4].includes(result.code)) break;
      }
      const deployed = plan.only ? [plan.only] : plan.names;
      const expected = Object.fromEntries(plan.names.map((name) => [name, !plan.canaryFails && deployed.includes(name) ? TARGET : LAST_GOOD]));
      const problems = [];
      if (result.code !== (plan.canaryFails ? 4 : 0)) problems.push(`the stack did not settle: last exit ${result.code}`);
      for (const [name, sfu] of Object.entries(sfus)) {
        if (!(sfu.container === "running" && !sfu.draining && sfu.image === expected[name])) problems.push(`${name} ends ${sfu.container}, draining ${sfu.draining}, on ${sfu.image}, not serving ${expected[name]}`);
      }
      if (problems.length) throw new Error(`seed ${plan.seed}, settled:\n  ${problems.join("\n  ")}\nplan: ${JSON.stringify(plan)}\n--- output ---\n${result.output}`);
    } finally {
      clearInterval(tick);
      for (const timer of timers) clearTimeout(timer);
    }
  });
};

const runs = Number(process.env.DEPLOY_FUZZ_RUNS ?? 100);
const firstSeed = Number(process.env.DEPLOY_FUZZ_SEED ?? 1);
for (let seed = firstSeed; seed < firstSeed + runs; seed += 1) {
  queued.push([`fault plan ${seed}`, () => runPlan(makePlan(seed))]);
}

describe("deploy-sfu.sh recovery", { concurrency: Number(process.env.DEPLOY_FUZZ_CONCURRENCY ?? 12) }, () => {
  for (const args of queued) test(...args);
});
