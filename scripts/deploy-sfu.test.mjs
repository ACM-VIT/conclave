import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test as nodeTest } from "node:test";
import { promisify } from "node:util";
import { hasHostTool, pathWithout, provideFlock } from "./test-support/host-tools.mjs";
import { composeUpByHand, cutRooms, deploy, dockerStandIn, passedPreflight, run, scripts, startSfu, withSfus } from "./test-support/deploy-harness.mjs";

// Every helper lives in test-support/deploy-harness.mjs. The tests run side
// by side (see the end of the file).
const queued = [];
const composeBuilds = (args) => args[0] === "compose" && args.slice(1).filter((arg, i, all) => !arg.startsWith("-") && !["-f", "--env-file", "--profile"].includes(all[i - 1]))[0] === "build";
const test = (...args) => queued.push(args);


const hasCompose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;

test("a plain compose up has nothing to build or pull for any SFU service, and the build lives in the build profile", { skip: !hasCompose && "needs docker compose" }, async () => {
  const root = path.join(scripts, "..");
  const env = { ...process.env, STAGING_REDIS_PASSWORD: "x", STAGING_BROWSER_SERVICE_URL: "http://127.0.0.1:1", STAGING_TRANSCRIPT_WORKER_URL: "http://127.0.0.1:1" };
  const rendered = (file, ...more) => JSON.parse(execFileSync("docker", ["compose", "-f", path.join(root, file), "--project-directory", root, "--env-file", "/dev/null", ...more, "config", "--format", "json"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  for (const file of ["docker-compose.sfu.yml", "docker-compose.sfu-staging.yml"]) {
    const plain = rendered(file);
    const sfus = Object.entries(plain.services).filter(([, service]) => JSON.stringify(service.environment ?? {}).includes("SFU_INSTANCE_ID"));
    assert.ok(sfus.length > 0, file);
    for (const [name, service] of sfus) {
      assert.equal(service.build, undefined, `${file} ${name} must not build`);
      assert.equal(service.pull_policy, "never", `${file} ${name} must never pull`);
    }
    assert.equal(plain.services["sfu-image"], undefined, `${file} starts no build service on a plain up`);
    assert.equal(rendered(file, "--profile", "build").services["sfu-image"]?.build?.dockerfile, "packages/sfu/Dockerfile", file);
  }
});

test("a compose file whose SFU service could build or pull an image is refused before anything changes", async () => {
  await withSfus({ "sfu-a": {}, "sfu-b": {} }, async (sfus) => {
    const result = await deploy(sfus, { env: { DEPLOY_TEST_COMPOSE_BUILDS: "1" } });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /must give sfu-a pull_policy: never and no build/);
    assert.deepEqual(Object.values(sfus).flatMap((sfu) => sfu.recreates), []);
  });
  await withSfus({ "sfu-a": {}, "sfu-b": {} }, async (sfus) => {
    const result = await deploy(sfus, { env: { DEPLOY_TEST_NO_IMAGE_SERVICE: "1" } });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /must define the SFU build as the sfu-image service/);
  });
});

test("with calls on both instances, the deploy rebuilds neither while those calls run", async () => {
  await withSfus({ "sfu-a": { rooms: 2 }, "sfu-b": { rooms: 1 } }, async (sfus) => {
    const result = await deploy(sfus);
    passedPreflight(result);
    assert.equal(result.code, 3, result.output);
    assert.equal(result.order, "sfu-b sfu-a", "the instance with fewer calls goes first");
    assert.deepEqual(cutRooms(sfus), [], "no instance may be recreated while it has calls");
    assert.equal(sfus["sfu-b"].draining, false, "the waited-on instance goes back into service");
    assert.equal(sfus["sfu-a"].drains.length, 0);
  });
});

test("an idle instance is rebuilt first, and the one carrying calls is not touched", async () => {
  await withSfus({ "sfu-a": { rooms: 2 }, "sfu-b": { rooms: 0 } }, async (sfus) => {
    const result = await deploy(sfus);
    passedPreflight(result);
    assert.equal(result.code, 3, result.output);
    assert.equal(result.order, "sfu-b sfu-a");
    assert.equal(sfus["sfu-b"].recreates.length, 2, "canary build, then the serving container");
    assert.equal(sfus["sfu-a"].recreates.length, 0);
    assert.deepEqual(cutRooms(sfus), [0, 0, 0, 0]);
  });
});

test("an instance whose status cannot be read is neither taken for the idle one nor drained against", async () => {
  await withSfus({ "sfu-a": { rooms: 2, statusAnswers: false }, "sfu-b": { rooms: 0 } }, async (sfus, events) => {
    const result = await deploy(sfus);
    assert.equal(result.code, 1, result.output);
    assert.equal(result.order, "sfu-b sfu-a");
    assert.match(result.output, /Not draining sfu-b: sfu-a is not serving \(its \/status cannot be read\)/);
    assert.deepEqual(events, [], "unknown is unsafe: nothing is drained or rebuilt");
  });
});

test("--force-drain is the one way to rebuild instances that carry calls", async () => {
  await withSfus({ "sfu-a": { rooms: 2 }, "sfu-b": { rooms: 1 } }, async (sfus) => {
    const result = await deploy(sfus, { args: ["--force-drain"] });
    assert.equal(result.code, 0, result.output);
    for (const sfu of Object.values(sfus)) {
      assert.equal(sfu.drains[0].force, true);
      assert.equal(sfu.recreates.length, 2);
    }
    assert.deepEqual(cutRooms(sfus), Array(8).fill(0), "each instance is stopped and recreated only after its forced drain");
  });
});

test("a replacement that never reports healthy stops the deploy before the other instance is drained", async () => {
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { replacementHealthy: false } }, async (sfus) => {
    const result = await deploy(sfus);
    assert.equal(result.code, 4, result.output);
    assert.match(result.output, /sfu-b did not report healthy/);
    assert.equal(sfus["sfu-a"].drains.length, 0, "the healthy instance keeps serving");
  });
});

for (const bootExit of ["exited", "crash-looping"]) {
  test(`a replacement that exits at boot (${bootExit}) is rolled back and the healthy peer is never drained`, async () => {
    await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { bootExit } }, async (sfus) => {
      const result = await deploy(sfus);
      assert.equal(result.code, 4, result.output);
      assert.match(result.output, /sfu-b did not report healthy/);
      assert.equal(sfus["sfu-a"].drains.length, 0, "the healthy peer keeps serving");
      assert.equal(sfus["sfu-b"].image, "sha256:running", "sfu-b is back on its previous image");
      assert.equal(sfus["sfu-b"].container, "running");
    });
  });
}

test("an instance that is down is brought up before a healthy one is drained", async () => {
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { container: "exited" } }, async (sfus, events) => {
    const result = await deploy(sfus);
    passedPreflight(result);
    assert.equal(result.code, 3, result.output);
    assert.equal(result.order, "sfu-b sfu-a");
    assert.deepEqual(events, ["recreate sfu-b", "recreate sfu-b", "drain sfu-a", "drain sfu-a"]);
    assert.deepEqual(cutRooms(sfus), [0, 0, 0, 0]);
  });
});

test("an instance that is down and whose replacement fails leaves the healthy one undrained", async () => {
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { container: "exited", replacementHealthy: false } }, async (sfus) => {
    const result = await deploy(sfus);
    // It never served on this host's record, so nothing known-good is put
    // back into rotation: it stays stopped, and the exit says it is down.
    assert.equal(result.code, 5, result.output);
    assert.match(result.output, /sfu-b has no image it last served calls on; it is stopped/);
    assert.equal(sfus["sfu-b"].container, "exited");
    assert.equal(sfus["sfu-a"].drains.length, 0);
  });
});

test("no instance is drained while another is down, even one outside the deploy", async () => {
  await withSfus({ "sfu-a": { rooms: 0 }, "sfu-b": { container: "exited" } }, async (sfus, events) => {
    const result = await deploy(sfus, { env: { SFU_DEPLOY_SERVICES: "sfu-a" } });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Not draining sfu-a: sfu-b is not serving \(.*\/health does not say healthy\)/);
    assert.deepEqual(events, []);
  });
});

test("an instance whose public URL does not reach it is left alone, and nothing else is drained", async () => {
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { rooms: 0 } }, async (sfus) => {
    // sfu-b's public route lands on sfu-a, as a misrouted proxy would: it
    // cannot be shown to serve before or after, so it is not rebuilt.
    const result = await deploy(sfus, { envLines: [`SFU_B_PUBLIC_URL=http://127.0.0.1:${sfus["sfu-a"].port}`] });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Public URL for sfu-b reaches instance 'sfu-a' instead/);
    assert.equal(sfus["sfu-b"].recreates.length, 0);
    assert.equal(sfus["sfu-b"].draining, false);
    assert.equal(sfus["sfu-a"].drains.length, 0);
  });
});

test("a new build whose public route fails after its canary is rolled back before the next drain (exit 4)", async () => {
  // The route reaches the old image and returns 502 for the new one.
  const onRecreate = (sfu) => (sfu.publicDown = sfu.image !== "sha256:running");
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { rooms: 0, publicRoute: true, onRecreate } }, async (sfus) => {
    const result = await deploy(sfus);
    assert.equal(result.code, 4, result.output);
    assert.match(result.output, /sfu-b passed its canary but is not serving .*public URL/);
    assert.equal(sfus["sfu-b"].image, "sha256:running");
    assert.equal(sfus["sfu-b"].draining, false);
    assert.equal(sfus["sfu-a"].drains.length, 0, "no drain may follow an unreachable replacement");
  });
});

test("the revision being deployed checks its own config before anything is built", async () => {
  await withSfus({ "sfu-a": { rooms: 0 }, "sfu-b": { rooms: 0 } }, async (sfus, events) => {
    // The next revision's preflight knows a limit the checkout's does not:
    // the checkout allows 3 workers within its budget of 4, the next allows 2.
    const newerPreflight = `
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
for (const [name, service] of Object.entries(JSON.parse(raw).services)) {
  if (Number(service.environment.SFU_WORKER_COUNT) > 2) {
    console.error(name + ": SFU_WORKER_COUNT " + service.environment.SFU_WORKER_COUNT + " is above this revision's limit of 2.");
    process.exit(1);
  }
}
console.log("SFU deployment preflight passed (newer rules).");
`;
    const result = await deploy(sfus, {
      envLines: ["SFU_WORKER_COUNT=3"],
      upstream: { "scripts/deploy-sfu-preflight.mjs": newerPreflight },
    });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /SFU_WORKER_COUNT 3 is above this revision's limit of 2/);
    const changes = result.docker.filter((args) => ["build", "up", "run", "tag", "stop"].some((verb) => args.includes(verb)));
    assert.deepEqual(changes, [], "nothing may be built or changed after the preflight fails");
    assert.deepEqual(events, []);
  });
});

test("a crash-looping instance is repaired first, before the healthy one is drained", async () => {
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { container: "crash-looping" } }, async (sfus, events) => {
    const result = await deploy(sfus);
    assert.equal(result.code, 3, result.output);
    assert.equal(result.order, "sfu-b sfu-a");
    assert.deepEqual(events, ["recreate sfu-b", "recreate sfu-b", "drain sfu-a", "drain sfu-a"]);
  });
});

test("an instance that has run for an hour but stays silent is left alone", async () => {
  await withSfus({ "sfu-a": { rooms: 0 }, "sfu-b": { container: "hung" } }, async (sfus, events) => {
    const result = await deploy(sfus, { env: { SFU_DEPLOY_SERVICES: "sfu-b" } });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /sfu-b's container is running but nothing answers/);
    assert.deepEqual(events, []);
  });
});

test("a preflight that reports nothing stops the deploy before anything is built", async () => {
  await withSfus({ "sfu-a": { rooms: 0 }, "sfu-b": { rooms: 0 } }, async (sfus) => {
    // It reads the compose JSON, then exits 0 without a verdict.
    const silent = "for await (const chunk of process.stdin) void chunk;\nprocess.exit(0);\n";
    const result = await deploy(sfus, { upstream: { "scripts/deploy-sfu-preflight.mjs": silent } });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /SFU deployment preflight reported no result/);
    const changes = result.docker.filter((args) => ["build", "up", "run", "tag", "stop"].some((verb) => args.includes(verb)));
    assert.deepEqual(changes, []);
  });
});

test("a peer left draining whose status cannot be read is not drained against", async () => {
  await withSfus({ "sfu-a": { draining: true, statusAnswers: false }, "sfu-b": { rooms: 0 } }, async (sfus) => {
    const result = await deploy(sfus);
    assert.equal(result.code, 1, result.output);
    assert.equal(sfus["sfu-b"].drains.length, 0, "sfu-b is the only instance still taking meetings");
  });
});

test("a rerun checks the public route of an instance already on the target", async () => {
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { onTarget: true } }, async (sfus) => {
    // sfu-b passed its canary on an earlier run but its public route lands on sfu-a.
    const result = await deploy(sfus, {
      envLines: [`SFU_B_PUBLIC_URL=http://127.0.0.1:${sfus["sfu-a"].port}`],
      journals: { "sfu-b": { phase: "idle", lkg: "sha256:target" } },
    });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /sfu-b already runs .* but clients cannot reach it/);
    assert.equal(sfus["sfu-a"].drains.length, 0);
  });
});

test("a partial rollback keeps the rollback target until every instance is back", async () => {
  await withSfus({ "sfu-a": { onTarget: true }, "sfu-b": { onTarget: true } }, async (sfus) => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "conclave-deploy-state-"));
    try {
      await writeFile(
        path.join(stateDir, "vm.env"),
        "LAST_GOOD_COMMIT=bad\nLAST_GOOD_IMAGE=sha256:target\nPREVIOUS_GOOD_COMMIT=good\nPREVIOUS_GOOD_IMAGE=sha256:previous\nVERIFIED_IMAGE=sha256:target\n",
      );
      const rollback = (svc) =>
        deploy(sfus, { args: ["--rollback"], env: { SFU_DEPLOY_SERVICES: svc, SFU_DEPLOY_STATE_DIR: stateDir } });

      const first = await rollback("sfu-a");
      assert.equal(first.code, 0, first.output);
      assert.equal(sfus["sfu-a"].image, "sha256:previous");
      assert.equal(sfus["sfu-b"].image, "sha256:target");
      assert.match(await readFile(path.join(stateDir, "vm.env"), "utf8"), /PREVIOUS_GOOD_IMAGE=sha256:previous/);

      const second = await rollback("sfu-b");
      assert.equal(second.code, 0, second.output);
      assert.equal(sfus["sfu-b"].image, "sha256:previous");
      const recorded = await readFile(path.join(stateDir, "vm.env"), "utf8");
      assert.match(recorded, /LAST_GOOD_IMAGE=sha256:previous/);
      assert.match(recorded, /PREVIOUS_GOOD_IMAGE=''\n/);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

test("a pull that changes deploy-sfu.sh hands the deploy to the new script", async () => {
  await withSfus({ "sfu-a": { rooms: 0 }, "sfu-b": { rooms: 0 } }, async (sfus) => {
    const current = await readFile(path.join(scripts, "deploy-sfu.sh"), "utf8");
    const marker = 'echo "The pulled deploy-sfu.sh is running."\n';
    const pulled = current.replace("set -euo pipefail\n", `set -euo pipefail\n${marker}`);
    assert.notEqual(pulled, current);
    const result = await deploy(sfus, { upstream: { "scripts/deploy-sfu.sh": pulled } });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /This pull changed deploy-sfu.sh; restarting with the new version/);
    assert.equal(result.output.split("The pulled deploy-sfu.sh is running.").length - 1, 1, "the new script runs once");
    assert.match(result.output, /SFU deploy complete/);
  });
});

const hasPowerShell = (() => {
  try {
    execFileSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("two deploys at once on one host: the second refuses and only one instance drains", async () => {
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { rooms: 1 } }, async (sfus, events, context) => {
    const lock = path.join(await mkdtemp(path.join(tmpdir(), "conclave-deploy-lock-")), "deploy.lock");
    // Hold every drain until both runs have reached one, as Sol's probe did.
    let release;
    const both = new Promise((resolve) => (release = resolve));
    const guard = setTimeout(release, 8000);
    let reached = 0;
    context.beforeDrain = async () => {
      reached += 1;
      if (reached === 2) release();
      await both;
    };
    try {
      const runs = await Promise.all(
        ["sfu-a", "sfu-b"].map((svc) =>
          deploy(sfus, { env: { SFU_DEPLOY_SERVICES: svc, SFU_DEPLOY_LOCK_FILE: lock, SFU_DEPLOY_LOCK_WAIT_SECONDS: "1", DRAIN_TIMEOUT_SECONDS: "3" } }),
        ),
      );
      assert.equal(runs.filter((run) => /still holds .* not starting a second one/.test(run.output)).length, 1, runs.map((run) => run.output).join("\n"));
      assert.equal(Object.values(sfus).filter((sfu) => sfu.drains.some((drain) => drain.draining)).length, 1);
    } finally {
      context.beforeDrain = null;
      clearTimeout(guard);
    }
  });
});

test("a rerun after an interrupted pair of deploys puts a healthy instance back into service and continues", async () => {
  await withSfus({ "sfu-a": { draining: true }, "sfu-b": { draining: true } }, async (sfus) => {
    const result = await deploy(sfus);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /No SFU is taking new meetings; putting sfu-a back into service/);
    assert.deepEqual(sfus["sfu-a"].drains[0], { draining: false });
    assert.equal(sfus["sfu-a"].recreates.length, 2);
    assert.equal(sfus["sfu-b"].recreates.length, 2);
  });
});

test("a management URL that answers as another instance is refused before any drain", async () => {
  await withSfus({ "sfu-a": { rooms: 2 }, "sfu-b": { rooms: 0 } }, async (sfus, events) => {
    // sfu-a's management URL reaches sfu-b, as in Astra's probe.
    const result = await deploy(sfus, { envLines: [`SFU_A_URL=http://127.0.0.1:${sfus["sfu-b"].port}`] });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /sfu-a is not serving \(its management URL answers as sfu-b, not sfu-a\)/);
    assert.deepEqual(events, []);
  });
});

test("a running container whose probes are silent is refused even when it started seconds ago", async () => {
  await withSfus({ "sfu-a": { rooms: 1, container: "young" }, "sfu-b": { rooms: 0 } }, async (sfus) => {
    const result = await deploy(sfus, { env: { SFU_DEPLOY_SERVICES: "sfu-a" } });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /sfu-a's container is running but nothing answers/);
    assert.deepEqual(cutRooms(sfus), []);
  });
});

test("a deploy of one instance refuses while the other is not publicly reachable", async () => {
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": {} }, async (sfus) => {
    const result = await deploy(sfus, { env: { SFU_DEPLOY_SERVICES: "sfu-a" }, envLines: ["SFU_B_PUBLIC_URL=http://127.0.0.1:9"] });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Not draining sfu-a: sfu-b is not serving \(its public URL/);
    assert.equal(sfus["sfu-a"].drains.length, 0);
  });
});

test("a deploy of one instance still runs the full preflight", async () => {
  await withSfus({ "sfu-a": { rooms: 0 }, "sfu-b": { rooms: 0 } }, async (sfus, events) => {
    const result = await deploy(sfus, { env: { SFU_DEPLOY_SERVICES: "sfu-a", DEPLOY_TEST_OVERLAP: "1" } });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /overlap/i);
    assert.deepEqual(events, []);
  });
});

test("a compose error at either recreate puts the instance back on its previous image", async () => {
  for (const failing of [1, 2]) {
    await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { rooms: 0, failRecreate: failing } }, async (sfus) => {
      const result = await deploy(sfus, { env: { SFU_DEPLOY_SERVICES: "sfu-b" } });
      assert.equal(result.code, 4, result.output);
      assert.match(result.output, /Rolling sfu-b back to its previous image/);
      assert.equal(sfus["sfu-b"].container, "running");
      assert.equal(sfus["sfu-b"].image, "sha256:running");
      assert.equal(sfus["sfu-a"].drains.length, 0);
    });
  }
});

test("--rollback after a partial rollout returns every instance to the last release that fully served", async () => {
  await withSfus({ "sfu-a": {}, "sfu-b": {} }, async (sfus) => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "conclave-deploy-state-"));
    try {
      // B served on both; A came before it; C reached sfu-b only.
      await writeFile(path.join(stateDir, "vm.env"), "LAST_GOOD_COMMIT=B\nLAST_GOOD_IMAGE=sha256:running\nPREVIOUS_GOOD_COMMIT=A\nPREVIOUS_GOOD_IMAGE=sha256:older\n");
      const partial = await deploy(sfus, { env: { SFU_DEPLOY_SERVICES: "sfu-b", SFU_DEPLOY_STATE_DIR: stateDir } });
      assert.equal(partial.code, 0, partial.output);
      assert.deepEqual(Object.values(sfus).map((sfu) => sfu.image), ["sha256:running", "sha256:target"]);
      const rollback = await deploy(sfus, { args: ["--rollback"], env: { SFU_DEPLOY_STATE_DIR: stateDir } });
      assert.equal(rollback.code, 0, rollback.output);
      assert.deepEqual(Object.values(sfus).map((sfu) => sfu.image), ["sha256:running", "sha256:running"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

for (const fault of ["transient list", "persistent list", "persistent inspect"]) {
  test(`rollback distinguishes an unknown image from a different release (${fault})`, async () => {
    await withSfus({ "sfu-a": { onTarget: true }, "sfu-b": { onTarget: true } }, async (sfus, events) => {
      const stateDir = await mkdtemp(path.join(tmpdir(), "conclave-deploy-state-"));
      try {
        const stateFile = path.join(stateDir, "vm.env");
        const prior = "LAST_GOOD_COMMIT=bad\nLAST_GOOD_IMAGE=sha256:target\nPREVIOUS_GOOD_COMMIT=good\nPREVIOUS_GOOD_IMAGE=sha256:previous\n";
        await writeFile(stateFile, prior);
        const sfu = sfus["sfu-b"];
        let failedReads = 0;
        const fail = () => ++failedReads === 1 || fault !== "transient list";
        sfu.onStatus = () => {
          if (fault === "persistent inspect") sfu.failImageRead = fail;
          else sfu.failContainerLookup = fail;
        };
        const result = await deploy(sfus, {
          args: ["--rollback"],
          env: { SFU_DEPLOY_STATE_DIR: stateDir, DEPLOY_TEST_EXPECT_LOOKUP_FAILURES: "sfu-b" },
        });
        assert.ok(failedReads > 0, result.output);
        if (fault === "transient list") {
          assert.equal(result.code, 0, result.output);
          assert.deepEqual(Object.values(sfus).map((instance) => instance.image), ["sha256:previous", "sha256:previous"], result.output);
        } else {
          assert.notEqual(result.code, 0, result.output);
          assert.deepEqual(events, [], result.output);
          assert.equal(await readFile(stateFile, "utf8"), prior, result.output);
        }
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    });
  });
}

test("an in-progress rollback does not drain any instance while a fleet image is unknown", async () => {
  await withSfus({ "sfu-a": { onTarget: true }, "sfu-b": { onTarget: true } }, async (sfus, events) => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "conclave-deploy-state-"));
    try {
      const stateFile = path.join(stateDir, "vm.env");
      const prior = "LAST_GOOD_COMMIT=bad\nLAST_GOOD_IMAGE=sha256:target\nPREVIOUS_GOOD_COMMIT=good\nPREVIOUS_GOOD_IMAGE=sha256:previous\nROLLBACK_TARGET_COMMIT=good\nROLLBACK_TARGET_IMAGE=sha256:previous\n";
      await writeFile(stateFile, prior);
      const sfu = sfus["sfu-b"];
      sfu.onStatus = () => { sfu.failImageRead = () => true; };
      const result = await deploy(sfus, { args: ["--rollback"], env: { SFU_DEPLOY_STATE_DIR: stateDir } });
      assert.notEqual(result.code, 0, result.output);
      assert.deepEqual(events, [], result.output);
      assert.equal(await readFile(stateFile, "utf8"), prior, result.output);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

test("an aborted state carry records recovery without restarting the old SFU", async () => {
  await withSfus({ "sfu-a": {}, "sfu-b": { rooms: 1 } }, async (sfus) => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "conclave-deploy-state-"));
    try {
      const sfu = sfus["sfu-a"];
      sfu.onUpdate = (instance, restart) => {
        if (restart === "no") instance.container = "restarting";
      };
      const result = await deploy(sfus, { env: { SFU_DEPLOY_STATE_DIR: stateDir } });
      assert.equal(result.code, 1, result.output);
      assert.equal(sfu.container, "restarting", result.output);
      assert.equal(sfu.restartPolicy, "unless-stopped", result.output);
      assert.deepEqual(sfu.recreates, [], result.output);
      assert.deepEqual(sfus["sfu-b"].drains, [], result.output);
      const journal = JSON.parse(await readFile(path.join(stateDir, "vm.sfu-a.journal.json"), "utf8"));
      assert.equal(journal.phase, "rollback", result.output);
      assert.equal(journal.lkg, "sha256:running", result.output);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

test("a rollback killed after its first instance finishes going back to the same release when rerun", async () => {
  await withSfus({ "sfu-a": { onTarget: true }, "sfu-b": { onTarget: true } }, async (sfus) => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "conclave-deploy-state-"));
    try {
      await writeFile(path.join(stateDir, "vm.env"), "LAST_GOOD_COMMIT=bad\nLAST_GOOD_IMAGE=sha256:target\nPREVIOUS_GOOD_COMMIT=good\nPREVIOUS_GOOD_IMAGE=sha256:previous\n");
      const rollback = (env = {}) => deploy(sfus, { args: ["--rollback"], env: { SFU_DEPLOY_STATE_DIR: stateDir, ...env } });
      // Killed once sfu-a's canary container and serving container are up.
      const killed = await rollback({ DEPLOY_TEST_KILL_AFTER_RECREATES: "2" });
      assert.equal(killed.code, null, killed.output);
      assert.deepEqual(Object.values(sfus).map((sfu) => sfu.image), ["sha256:previous", "sha256:target"]);

      const rerun = await rollback();
      assert.equal(rerun.code, 0, rerun.output);
      assert.match(rerun.output, /Finishing the rollback to good/);
      assert.deepEqual(Object.values(sfus).map((sfu) => sfu.image), ["sha256:previous", "sha256:previous"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

test("a rollback paused by a call (exit 3) keeps its target for the rerun", async () => {
  await withSfus({ "sfu-a": { onTarget: true }, "sfu-b": { onTarget: true, rooms: 1 } }, async (sfus) => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "conclave-deploy-state-"));
    try {
      await writeFile(path.join(stateDir, "vm.env"), "LAST_GOOD_COMMIT=bad\nLAST_GOOD_IMAGE=sha256:target\nPREVIOUS_GOOD_COMMIT=good\nPREVIOUS_GOOD_IMAGE=sha256:previous\n");
      const rollback = () => deploy(sfus, { args: ["--rollback"], env: { SFU_DEPLOY_STATE_DIR: stateDir } });
      const paused = await rollback();
      assert.equal(paused.code, 3, paused.output);
      assert.deepEqual(Object.values(sfus).map((sfu) => sfu.image), ["sha256:previous", "sha256:target"]);

      sfus["sfu-b"].rooms = 0;
      const rerun = await rollback();
      assert.equal(rerun.code, 0, rerun.output);
      assert.deepEqual(Object.values(sfus).map((sfu) => sfu.image), ["sha256:previous", "sha256:previous"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

test("a silent instance whose container state Docker cannot report is not rebuilt", async () => {
  await withSfus({ "sfu-a": {}, "sfu-b": { container: "hung", rooms: 1, stateInspectFails: true } }, async (sfus) => {
    const result = await deploy(sfus, { env: { SFU_DEPLOY_SERVICES: "sfu-b", CONTAINER_SAMPLE_SECONDS: "0" } });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Docker could not report the state of sfu-b's container/);
    assert.deepEqual(sfus["sfu-b"].recreates, []);
  });
});

// The release before this lock code: it locked OLD_DEPLOY_LOCK_FILE and
// marked the lock held with a bare flag. A pull then brings this script and
// the deploy restarts into it.
const olderScript = async () => {
  const current = await readFile(path.join(scripts, "deploy-sfu.sh"), "utf8");
  const older = current.replace(
    /^if \[\[ -d \/run\/lock \]\]; then\n[\s\S]*?^export SFU_DEPLOY_LOCK_HELD=.*\n/m,
    'DEPLOY_LOCK="$OLD_DEPLOY_LOCK_FILE"\n[[ -n "${SFU_DEPLOY_LOCK_HELD:-}" ]] || exec 9>>"$DEPLOY_LOCK"\nflock -n 9 || exit 1\nexport SFU_DEPLOY_LOCK_HELD=1\n',
  );
  assert.notEqual(older, current);
  return { current, older };
};

test("a deploy that restarts into this script holding the same lock file under the old flag deploys at once", async () => {
  await withSfus({ "sfu-a": {}, "sfu-b": {} }, async (sfus) => {
    const dir = await mkdtemp(path.join(tmpdir(), "conclave-deploy-lock-"));
    const lock = path.join(dir, "deploy.lock");
    const { current, older } = await olderScript();
    try {
      const result = await deploy(sfus, {
        script: older,
        upstream: { "scripts/deploy-sfu.sh": current },
        env: { OLD_DEPLOY_LOCK_FILE: lock, SFU_DEPLOY_LOCK_FILE: lock, SFU_DEPLOY_LOCK_WAIT_SECONDS: "3" },
      });
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /This pull changed deploy-sfu.sh; restarting with the new version/);
      assert.doesNotMatch(result.output, /waiting up to/, "it never waits on its own lock");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("a deploy that restarts into this script from one that locked another file takes this lock too", async () => {
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { rooms: 1 } }, async (sfus, events, context) => {
    const dir = await mkdtemp(path.join(tmpdir(), "conclave-deploy-lock-"));
    const lock = path.join(dir, "deploy.lock");
    const { current, older } = await olderScript();
    let releaseDrains;
    const drainsReleased = new Promise((resolve) => (releaseDrains = resolve));
    let firstAtDrain;
    const firstReached = new Promise((resolve) => (firstAtDrain = resolve));
    let reached = 0;
    context.beforeDrain = async () => {
      reached += 1;
      if (reached === 1) firstAtDrain();
      else releaseDrains();
      await drainsReleased;
    };
    const guard = setTimeout(() => releaseDrains(), 30_000);
    try {
      const restarted = deploy(sfus, {
        script: older,
        upstream: { "scripts/deploy-sfu.sh": current },
        env: { SFU_DEPLOY_SERVICES: "sfu-a", OLD_DEPLOY_LOCK_FILE: path.join(dir, "old.lock"), SFU_DEPLOY_LOCK_FILE: lock, DRAIN_TIMEOUT_SECONDS: "3" },
      });
      await firstReached;
      const second = await deploy(sfus, {
        env: { SFU_DEPLOY_SERVICES: "sfu-b", SFU_DEPLOY_LOCK_FILE: lock, SFU_DEPLOY_LOCK_WAIT_SECONDS: "1", DRAIN_TIMEOUT_SECONDS: "3" },
      });
      releaseDrains();
      const first = await restarted;
      assert.match(first.output, /This pull changed deploy-sfu.sh; restarting with the new version/, first.output);
      assert.equal(second.code, 1, second.output);
      assert.match(second.output, /still holds .* not starting a second one/);
      assert.equal(sfus["sfu-b"].drains.filter((drain) => drain.draining).length, 0, "the second deploy drained nothing");
    } finally {
      context.beforeDrain = null;
      clearTimeout(guard);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Resolves once at least count processes hold path open: the holder, and
// the run that now waits on it.
const openedBy = async (path_, count) => {
  for (let i = 0; i < 400; i += 1) {
    const pids = await run("lsof", ["-t", path_]).then((r) => r.stdout.split("\n").filter(Boolean), () => []);
    if (pids.length >= count) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`${path_} was never opened by ${count} processes`);
};

test("a deploy that waited on a lock file replaced meanwhile does not run on the old one", { skip: !hasHostTool("lsof") && "needs lsof on PATH" }, async () => {
  await withSfus({ "sfu-a": {}, "sfu-b": {} }, async (sfus, events) => {
    const dir = await mkdtemp(path.join(tmpdir(), "conclave-deploy-lock-"));
    const lock = path.join(dir, "deploy.lock");
    const bin = path.join(dir, "bin");
    await mkdir(bin);
    await provideFlock(bin);
    const holder = spawn("bash", ["-c", 'exec 7>>"$1"; flock -n 7 && echo locked && exec sleep 30', "_", lock], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    try {
      await new Promise((done) => holder.stdout.once("data", done));
      const running = deploy(sfus, { env: { SFU_DEPLOY_LOCK_FILE: lock, SFU_DEPLOY_LOCK_WAIT_SECONDS: "30" } });
      // While the deploy waits, the lock file is replaced, then the holder ends.
      await openedBy(lock, 2);
      await rm(lock);
      await writeFile(lock, "");
      holder.kill();
      const result = await running;
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /deploy\.lock was replaced while this deploy waited for it/);
      assert.deepEqual(events, []);
    } finally {
      holder.kill();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("a deploy waits for a backup holding the host lock, then runs", async () => {
  await withSfus({ "sfu-a": {}, "sfu-b": {} }, async (sfus) => {
    const dir = await mkdtemp(path.join(tmpdir(), "conclave-deploy-lock-"));
    const lock = path.join(dir, "deploy.lock");
    const bin = path.join(dir, "bin");
    await mkdir(bin);
    await provideFlock(bin);
    // The backup: holds the lock for 2 s.
    const backup = spawn("bash", ["-c", 'exec 7>>"$1"; flock -n 7 && echo locked && sleep 2', "_", lock], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    try {
      await new Promise((done) => backup.stdout.once("data", done));
      const result = await deploy(sfus, { env: { SFU_DEPLOY_LOCK_FILE: lock, SFU_DEPLOY_LOCK_WAIT_SECONDS: "30" } });
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /Another SFU deploy or a backup holds .*; waiting up to 30s/);
    } finally {
      backup.kill();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("a deploy paused by a call leaves that instance's compose image on the release it runs", async () => {
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { rooms: 2 } }, async (sfus) => {
    const result = await deploy(sfus, { env: { DEPLOY_TEST_NO_COMMIT_IMAGES: "1" } });
    assert.equal(result.code, 3, result.output);
    assert.equal(result.order, "sfu-a sfu-b");
    assert.equal(result.tags["vm-sfu-a"], undefined, "sfu-a's compose image was never moved to the untested build");
    assert.ok(!result.docker.some(composeBuilds), "no service image is built");
    const built = result.docker.find((args) => args[0] === "build");
    assert.match(built[built.indexOf("-t") + 1], /^vm-sfu:[0-9a-f]{12}-candidate$/);
    assert.deepEqual(cutRooms(sfus), []);
  });
});

test("an instance on the target whose status says unhealthy is redeployed, not counted as deployed", async () => {
  await withSfus({ "sfu-a": { onTarget: true, statusHealthy: false }, "sfu-b": { onTarget: true } }, async (sfus) => {
    // Both passed their canary on an earlier run.
    const result = await deploy(sfus, { journals: { "sfu-a": { phase: "idle", lkg: "sha256:target" }, "sfu-b": { phase: "idle", lkg: "sha256:target" } } });
    assert.equal(result.code, 0, result.output);
    assert.doesNotMatch(result.output, /sfu-a already runs/);
    assert.equal(sfus["sfu-a"].recreates.length, 2, "canary container, then the serving one");
    assert.equal(sfus["sfu-b"].recreates.length, 0);
    assert.match(result.output, /sfu-b already runs .* leaving it alone/);
  });
});

test("a host without Python is refused before any SFU changes", async () => {
  await withSfus({ "sfu-a": {} }, async (sfus, events) => {
    const result = await deploy(sfus, { withoutPython: true });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /needs python3 to validate the host deploy lock/);
    assert.deepEqual(events, []);
  });
});

test("a host without flock refuses to deploy rather than lock some other way", async () => {
  await withSfus({ "sfu-a": {}, "sfu-b": {} }, async (sfus, events) => {
    const result = await deploy(sfus, { withoutFlock: true });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /needs flock \(util-linux\)/);
    assert.deepEqual(events, []);
  });
});

test("deploy-sfu.ps1 refuses to start on Windows and says to run deploy-sfu.sh in WSL", { skip: !hasPowerShell && "needs pwsh on PATH" }, async () => {
  await withSfus({ "sfu-a": {}, "sfu-b": {} }, async (sfus) => {
    // OS=Windows_NT is how Windows identifies itself to every process.
    const result = await deploy(sfus, { powershell: true, env: { OS: "Windows_NT" } });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Open a WSL shell in the checkout and run \.\/scripts\/deploy-sfu\.sh/);
    assert.deepEqual(result.docker, [], "deploy-sfu.sh never ran");
  });
});

test("deploy-sfu.ps1 hands the deploy, --rollback included, to deploy-sfu.sh", { skip: !hasPowerShell && "needs pwsh on PATH" }, async () => {
  await withSfus({ "sfu-a": { onTarget: true }, "sfu-b": { onTarget: true } }, async (sfus) => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "conclave-deploy-state-"));
    try {
      await writeFile(path.join(stateDir, "vm.env"), "LAST_GOOD_COMMIT=bad\nLAST_GOOD_IMAGE=sha256:target\nPREVIOUS_GOOD_COMMIT=good\nPREVIOUS_GOOD_IMAGE=sha256:previous\n");
      const result = await deploy(sfus, { powershell: true, args: ["--rollback"], env: { SFU_DEPLOY_STATE_DIR: stateDir } });
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /Rollback: the checkout stays at/);
      assert.deepEqual(Object.values(sfus).map((sfu) => sfu.image), ["sha256:previous", "sha256:previous"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

test("the canary runs from one bundled file, without the SFU's dev dependencies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-canary-"));
  try {
    // An empty directory stands in for an image installed with production
    // dependencies only: nothing but the bundle and Node.
    await run(process.execPath, [path.join(scripts, "..", "packages", "sfu", "scripts", "build-canary.mjs"), path.join(root, "canary-call.mjs")]);
    const bare = await run(process.execPath, [path.join(root, "canary-call.mjs")], { cwd: root }).then(
      () => ({ code: 0, output: "" }),
      (error) => ({ code: error.code, output: `${error.stdout}${error.stderr}` }),
    );
    assert.doesNotMatch(bare.output, /ERR_MODULE_NOT_FOUND/);
    assert.equal(bare.code, 2, bare.output);
    assert.match(bare.output, /Usage: SFU_SECRET=/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a rollback to a release built before the canary bundle runs the checkout's canary against it", async () => {
  await withSfus({ "sfu-a": { onTarget: true }, "sfu-b": { onTarget: true } }, async (sfus) => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "conclave-deploy-state-"));
    try {
      await writeFile(path.join(stateDir, "vm.env"), "LAST_GOOD_COMMIT=bad\nLAST_GOOD_IMAGE=sha256:target\nPREVIOUS_GOOD_COMMIT=good\nPREVIOUS_GOOD_IMAGE=sha256:previous\n");
      const result = await deploy(sfus, {
        args: ["--rollback"],
        env: { SFU_DEPLOY_STATE_DIR: stateDir, DEPLOY_TEST_NO_BUNDLE: "sha256:previous" },
      });
      assert.equal(result.code, 0, result.output);
      assert.deepEqual(Object.values(sfus).map((sfu) => sfu.image), ["sha256:previous", "sha256:previous"]);
      const canaries = result.docker.filter((args) => args[0] === "run");
      assert.equal(canaries.length, 2, "one canary per instance");
      for (const canary of canaries) {
        assert.equal(canary[canary.indexOf("--entrypoint") + 2], "sha256:target", "the checkout's image runs the canary");
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

test("a rollback whose checkout was never built builds its canary under its own tag, and a retry after a partial rollback keeps every service image", async () => {
  await withSfus({ "sfu-a": { onTarget: true }, "sfu-b": { onTarget: true, rooms: 1 } }, async (sfus) => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "conclave-deploy-state-"));
    try {
      await writeFile(path.join(stateDir, "vm.env"), "LAST_GOOD_COMMIT=bad\nLAST_GOOD_IMAGE=sha256:target\nPREVIOUS_GOOD_COMMIT=good\nPREVIOUS_GOOD_IMAGE=sha256:previous\n");
      const env = {
        SFU_DEPLOY_STATE_DIR: stateDir,
        DEPLOY_TEST_DOCKER_TAGS: path.join(stateDir, "docker-tags.json"),
        DEPLOY_TEST_NO_BUNDLE: "sha256:previous",
        DEPLOY_TEST_NO_COMMIT_IMAGES: "1",
      };
      // sfu-b still has a call, so the first run rolls back sfu-a only.
      const partial = await deploy(sfus, { args: ["--rollback"], env });
      assert.equal(partial.code, 3, partial.output);
      sfus["sfu-b"].rooms = 0;
      const retry = await deploy(sfus, { args: ["--rollback"], env });
      assert.equal(retry.code, 0, retry.output);

      assert.deepEqual(Object.values(sfus).map((sfu) => sfu.image), ["sha256:previous", "sha256:previous"]);
      assert.equal(retry.tags["vm-sfu-a"], "sha256:previous", "sfu-a's compose image still names the rollback release");
      assert.equal(retry.tags["vm-sfu-b"], "sha256:previous");
      for (const run of [partial, retry]) {
        assert.ok(!run.docker.some(composeBuilds), "no service image is rebuilt");
      }
      assert.match(partial.output, /Building [0-9a-f]{12} as vm-sfu-canary:[0-9a-f]{12} for deploy checks/);
      assert.doesNotMatch(retry.output, /Building/, "the retry reuses the canary image");
      const canaryImages = retry.docker.filter((args) => args[0] === "run").map((args) => args[args.indexOf("--entrypoint") + 2]);
      assert.deepEqual(canaryImages, ["sha256:canary-build"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

test("the deploy runs the bundled canary from the image", async () => {
  await withSfus({ "sfu-a": { rooms: 0 }, "sfu-b": { rooms: 0 } }, async (sfus) => {
    const result = await deploy(sfus, { env: { SFU_DEPLOY_SERVICES: "sfu-a" } });
    assert.equal(result.code, 0, result.output);
    const canary = result.docker.find((args) => args[0] === "run");
    assert.ok(canary, "the canary ran");
    assert.ok(canary.includes("dist/canary-call.mjs"), canary.join(" "));
    assert.ok(!canary.includes("tsx"), canary.join(" "));
  });
});

test("a deploy never falls back to a build an interrupted canary left drained", async () => {
  // Sol's probe: revision A fails its canary and the deploy dies right then,
  // leaving sfu-a drained on A. The next deploy, of B, fails its canary too.
  await withSfus({ "sfu-a": {}, "sfu-b": { rooms: 1 } }, async (sfus) => {
    const dir = await mkdtemp(path.join(tmpdir(), "deploy-fallback-"));
    try {
      const env = { SFU_DEPLOY_STATE_DIR: dir, DEPLOY_TEST_DOCKER_TAGS: path.join(dir, "docker-tags.json") };
      const first = await deploy(sfus, { env: { ...env, DEPLOY_TEST_BAD_IMAGES: "sha256:target", DEPLOY_TEST_KILL_ON_CANARY_FAILURE: "1" } });
      assert.equal(first.code, null, first.output);
      assert.equal(sfus["sfu-a"].image, "sha256:target");
      assert.equal(sfus["sfu-a"].draining, true);

      const next = await deploy(sfus, {
        env: { ...env, DEPLOY_TEST_NO_COMMIT_IMAGES: "1", DEPLOY_TEST_BAD_IMAGES: "sha256:target,sha256:candidate-build" },
        upstream: { "packages/sfu/config/workerSettings.mjs": `${await readFile(path.join(scripts, "..", "packages", "sfu", "config", "workerSettings.mjs"), "utf8")}\n// a newer build\n` },
      });
      assert.equal(next.code, 4, next.output);
      assert.match(next.output, /the canary call against sfu-a failed/);
      assert.equal(sfus["sfu-a"].image, "sha256:running", "back on the image it last served calls on, never on A");
      assert.equal(sfus["sfu-a"].draining, false);
      assert.equal(sfus["sfu-b"].drains.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("a compose that starts another image than the one tagged for the deploy fails it loudly", async () => {
  // Sol's probe: with COMPOSE_COMPATIBILITY=true and an implicit image name,
  // Compose started vm_sfu-a, so the tag on vm-sfu-a never reached the
  // container. Here the stand-in starts the old image whatever it is told.
  await withSfus({ "sfu-a": {}, "sfu-b": {} }, async (sfus) => {
    const result = await deploy(sfus, { env: { DEPLOY_TEST_COMPOSE_IGNORES_IMAGE: "1" } });
    assert.notEqual(result.code, 0, result.output);
    assert.match(result.output, /compose started sfu-[ab] on sha256:running, not the image tagged for it/);
    assert.doesNotMatch(result.output, /SFU deploy complete/);
  });
});

test("a canary failure whose rollback cannot bring the instance back exits 5, not 4", async () => {
  // Sol's probe: the canary fails, then compose fails to restart the
  // previous image, so the instance is down.
  await withSfus({ "sfu-a": { failRecreate: 2 }, "sfu-b": { rooms: 1 } }, async (sfus) => {
    const result = await deploy(sfus, { env: { DEPLOY_TEST_NO_BUNDLE: "sha256:target" } });
    assert.equal(result.code, 5, result.output);
    assert.match(result.output, /compose could not restart sfu-a on its previous image; it is down/);
    assert.equal(sfus["sfu-a"].container, "exited");
    assert.equal(sfus["sfu-b"].drains.length, 0);
  });
});

test("a host bash older than 4 is refused with a message that says why", { skip: !/^3\./.test(spawnSync("/bin/bash", ["-c", "echo $BASH_VERSION"], { encoding: "utf8" }).stdout ?? "") && "needs a bash 3 at /bin/bash (macOS)" }, async () => {
  const result = spawnSync("/bin/bash", [path.join(scripts, "deploy-sfu.sh"), "--help"], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /deploy-sfu\.sh needs bash 4 or newer; this is bash 3\./);
});

test("FORCE_COLOR in the environment does not change the numbers the deploy reads", async () => {
  // CI sets it for readable logs; node then colors a bare number it logs.
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { rooms: 0 } }, async (sfus) => {
    const result = await deploy(sfus, { env: { FORCE_COLOR: "1" } });
    assert.equal(result.order, "sfu-b sfu-a", result.output);
    assert.match(result.output, /sfu-b active rooms: 0\n/);
  });
});

test("a serving container whose env Docker cannot read is never taken for one that served", async () => {
  // Greptile: a failed inspect gave grep no match, which read as "did not
  // boot drained".
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { rooms: 0, envInspectFails: true } }, async (sfus) => {
    const result = await deploy(sfus, { env: { SFU_DEPLOY_SERVICES: "sfu-b", DEPLOY_TEST_NO_BUNDLE: "sha256:target" } });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /sfu-b is not serving \(Docker cannot read its container's env\) and no image it served on is on record/);
    assert.equal(sfus["sfu-b"].drains.length, 0, "it is not drained");
    assert.equal(sfus["sfu-b"].recreates.length, 0, "it keeps running as it is");
    assert.equal(sfus["sfu-a"].drains.length, 0);
  });
});

test("a drained instance whose env Docker cannot read is not put back into service", async () => {
  // Greptile: with no instance serving, an unreadable env counted as a
  // container that had served, so an untested build could take meetings.
  await withSfus({ "sfu-a": { draining: true, envInspectFails: true }, "sfu-b": { draining: true } }, async (sfus) => {
    const result = await deploy(sfus);
    assert.deepEqual(sfus["sfu-a"].drains.filter((request) => request.draining === false), [], result.output);
    assert.ok(sfus["sfu-b"].drains.some((request) => request.draining === false), "the readable one goes back into service");
  });
});

test("a forced drain with a long notice waits for the SFU's answer, and a notice past its cap is refused", async () => {
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { rooms: 1 } }, async (sfus) => {
    const refused = await deploy(sfus, { args: ["--force-drain", "--force-drain-notice-ms=30001"] });
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, /at most 30000/);
    assert.equal(sfus["sfu-a"].drains.length + sfus["sfu-b"].drains.length, 0);

    const result = await deploy(sfus, { args: ["--force-drain", "--force-drain-notice-ms=10500"], env: { SFU_DEPLOY_SERVICES: "sfu-a" } });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Force drain applied to sfu-a/);
  });
});

test("a compose file with its own Redis starts it, with Upstash settings inherited or no Redis URL in .env", async () => {
  await withSfus({ "sfu-a": {}, "sfu-b": {} }, async (sfus) => {
    const result = await deploy(sfus, {
      env: { DEPLOY_TEST_REDIS_SERVICE: "1", UPSTASH_REDIS_REST_URL: "https://upstash.example", UPSTASH_REDIS_REST_TOKEN: "token" },
      noRedisUrl: true,
    });
    assert.equal(result.code, 0, result.output);
    assert.ok(result.docker.some((args) => args[0] === "compose" && args.slice(-3).join(" ") === "up -d redis"), result.output);
  });
});

test("the deploy lock is made so no other user can open it, and one that is a link is refused", async () => {
  await withSfus({ "sfu-a": {}, "sfu-b": {} }, async (sfus) => {
    const dir = await mkdtemp(path.join(tmpdir(), "deploy-lock-"));
    try {
      const lock = path.join(dir, "deploy.lock");
      const made = await deploy(sfus, { env: { SFU_DEPLOY_LOCK_FILE: lock } });
      assert.equal(made.code, 0, made.output);
      assert.equal((await stat(lock)).mode & 0o777, 0o640);
      // One an older script made for every user is narrowed by its owner.
      await chmod(lock, 0o666);
      await deploy(sfus, { env: { SFU_DEPLOY_LOCK_FILE: lock } });
      assert.equal((await stat(lock)).mode & 0o777, 0o640);
      await rm(lock);
      await writeFile(path.join(dir, "elsewhere.lock"), "");
      await symlink(path.join(dir, "elsewhere.lock"), lock);
      const drains = sfus["sfu-a"].drains.length + sfus["sfu-b"].drains.length;
      const linked = await deploy(sfus, { env: { SFU_DEPLOY_LOCK_FILE: lock } });
      assert.equal(linked.code, 1, linked.output);
      assert.match(linked.output, /deploy\.lock is a link or not a regular file/);
      assert.equal(sfus["sfu-a"].drains.length + sfus["sfu-b"].drains.length, drains, "the refused run drained nothing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("staging waits for its own Redis with the default health timeout", async () => {
  await withSfus({ "sfu-a": {} }, async (sfus) => {
    const result = await deploy(sfus, {
      noRedisUrl: true,
      env: {
        DEPLOY_TEST_REDIS_SERVICE: "1",
        DEPLOY_TEST_REDIS_START_DELAY_CHECKS: "2",
        HEALTH_TIMEOUT_SECONDS: undefined,
      },
    });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Every SFU's Redis URL reaches/);
    assert.equal(result.docker.filter((args) => args[0] === "inspect" && args.at(-1) === "ctr-redis").length, 3);
  });
});

test("a compose file's own Redis must be the one its SFUs reach, checked by run id before any SFU starts", async () => {
  for (const [env, why] of [
    [{ DEPLOY_TEST_REDIS_URL_RUN_ID: "another-redis" }, /sfu-a's SFU_REDIS_URL reaches a Redis whose run id is another-redis, not .*own Redis \(own-redis\)/],
    [{ DEPLOY_TEST_REDIS_STATE: "exited" }, /own Redis is not running or does not answer on its socket/],
  ]) {
    await withSfus({ "sfu-a": {}, "sfu-b": {} }, async (sfus) => {
      const result = await deploy(sfus, { env: { DEPLOY_TEST_REDIS_SERVICE: "1", HEALTH_TIMEOUT_SECONDS: "1", ...env }, noRedisUrl: true });
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, why);
      assert.deepEqual(Object.values(sfus).flatMap((sfu) => [...sfu.recreates, ...sfu.drains]), [], result.output);
    });
  }
  await withSfus({ "sfu-a": {}, "sfu-b": {} }, async (sfus) => {
    const result = await deploy(sfus, { env: { DEPLOY_TEST_REDIS_SERVICE: "1" }, noRedisUrl: true });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Every SFU's Redis URL reaches .*own Redis \(run id own-redis\)/);
  });
});

// --- Sol's second final review: crashes and interruptions mid-deploy.

const sharedRun = async (prefix) => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return { dir, env: { SFU_DEPLOY_STATE_DIR: path.join(dir, "state"), DEPLOY_TEST_DOCKER_TAGS: path.join(dir, "tags.json"), SFU_DEPLOY_LOCK_FILE: path.join(dir, "deploy.lock") } };
};

test("after a canary failure kills the deploy, a hand-run compose up starts the last good image and the retry runs the canary", async () => {
  await withSfus({ "sfu-a": {}, "sfu-b": { rooms: 1 } }, async (sfus) => {
    const shared = await sharedRun("deploy-crash-");
    try {
      const first = await deploy(sfus, { env: { ...shared.env, DEPLOY_TEST_BAD_IMAGES: "sha256:target", DEPLOY_TEST_KILL_ON_CANARY_FAILURE: "1" } });
      assert.equal(first.code, null, first.output);
      // An operator brings sfu-a up by hand: Compose starts whatever the
      // service's own image name points at.
      await composeUpByHand(sfus, { tags: shared.env.DEPLOY_TEST_DOCKER_TAGS, dir: path.join(shared.dir, "by-hand") }, "sfu-a");
      assert.equal(sfus["sfu-a"].image, "sha256:running", "the service's own tag never named the build that failed");
      assert.equal(sfus["sfu-a"].draining, false);
      const retry = await deploy(sfus, { env: { ...shared.env, DEPLOY_TEST_BAD_IMAGES: "sha256:target" } });
      assert.equal(retry.code, 4, retry.output);
      assert.match(retry.output, /Running the canary call against sfu-a/);
      assert.equal(sfus["sfu-a"].image, "sha256:running");
      assert.equal(sfus["sfu-a"].draining, false);
    } finally {
      await rm(shared.dir, { recursive: true, force: true });
    }
  });
});

test("a deploy killed just after an instance accepted its drain leaves its last good image on record", async () => {
  await withSfus({ "sfu-a": {}, "sfu-b": { rooms: 1 } }, async (sfus) => {
    const shared = await sharedRun("deploy-crash-");
    try {
      const first = await deploy(sfus, { env: { ...shared.env, SFU_DEPLOY_TEST_CRASH_AT: "drain sfu-a" } });
      assert.equal(first.code, null, first.output);
      assert.equal(sfus["sfu-a"].draining, true);
      // The next deploy's build fails its canary: sfu-a must go back to the
      // image it served on, not be stopped for want of one.
      const retry = await deploy(sfus, { env: { ...shared.env, DEPLOY_TEST_NO_BUNDLE: "sha256:target" } });
      assert.equal(retry.code, 4, retry.output);
      assert.equal(sfus["sfu-a"].image, "sha256:running");
      assert.equal(sfus["sfu-a"].container, "running");
      assert.equal(sfus["sfu-a"].draining, false);
    } finally {
      await rm(shared.dir, { recursive: true, force: true });
    }
  });
});

test("an inherited SFU_START_DRAINING=true never leaves a deployed instance drained", async () => {
  await withSfus({ "sfu-a": {}, "sfu-b": {} }, async (sfus) => {
    const result = await deploy(sfus, { envLines: ["SFU_START_DRAINING=true"], env: { SFU_START_DRAINING: "true" } });
    assert.equal(result.code, 0, result.output);
    for (const sfu of Object.values(sfus)) {
      assert.equal(sfu.image, "sha256:target");
      assert.equal(sfu.draining, false, `${sfu.instanceId} serves`);
      assert.equal(sfu.bootDrained, false, `${sfu.instanceId}'s container did not boot drained`);
    }
  });
});

test("a rollback whose public route returns 502 is not reported as restored (exit 5, not 4)", async () => {
  // Sol's probe: the management URL answers, the route clients use does not.
  const onRecreate = (sfu) => (sfu.publicDown = true);
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { rooms: 0, publicRoute: true, onRecreate } }, async (sfus) => {
    const result = await deploy(sfus, { env: { DEPLOY_TEST_NO_BUNDLE: "sha256:target" } });
    assert.equal(result.code, 5, result.output);
    assert.match(result.output, /sfu-b is back on its previous image but is not serving \(its public URL/);
    assert.equal(sfus["sfu-a"].drains.length, 0);
  });
});

// --- Greptile on 426f7eef.

test("repair never restarts an instance that already serves its last-known-good image", async () => {
  // A rollback killed after sfu-a came back serving: its journal still says
  // rollback, but it takes calls, so restarting it would cut a caller who
  // joined since.
  await withSfus({ "sfu-a": {}, "sfu-b": { rooms: 1 } }, async (sfus) => {
    const shared = await sharedRun("deploy-repair-");
    try {
      const first = await deploy(sfus, { env: { ...shared.env, DEPLOY_TEST_NO_BUNDLE: "sha256:target", SFU_DEPLOY_TEST_CRASH_AT: "start sfu-a back" } });
      assert.equal(first.code, null, first.output);
      assert.equal(sfus["sfu-a"].image, "sha256:running");
      assert.equal(sfus["sfu-a"].draining, false);
      const recreates = sfus["sfu-a"].recreates.length;
      const next = await deploy(sfus, { env: { ...shared.env, SFU_DEPLOY_SERVICES: "sfu-b" } });
      assert.equal(sfus["sfu-a"].recreates.length, recreates, `sfu-a was not restarted:\n${next.output}`);
      assert.equal(sfus["sfu-a"].draining, false);
    } finally {
      await rm(shared.dir, { recursive: true, force: true });
    }
  });
});

test("repair never restarts an instance whose status it cannot read", async () => {
  // A candidate phase on record, but sfu-a's /status does not answer while
  // its container runs: its calls are unknown, so it is not restarted.
  await withSfus({ "sfu-a": { statusAnswers: false }, "sfu-b": { rooms: 1 } }, async (sfus) => {
    const result = await deploy(sfus, {
      env: { SFU_DEPLOY_SERVICES: "sfu-b" },
      journals: { "sfu-a": { phase: "candidate", lkg: "sha256:running", candidate: "sha256:target" } },
    });
    assert.equal(sfus["sfu-a"].recreates.length, 0, result.output);
    assert.match(result.output, /sfu-a cannot be rolled back without risking its calls: its \/status has not answered/);
  });
});

test("an inherited SFU_START_DRAINING=true does not make a retry redo finished instances", async () => {
  await withSfus({ "sfu-a": { onTarget: true }, "sfu-b": { onTarget: true } }, async (sfus) => {
    const result = await deploy(sfus, {
      envLines: ["SFU_START_DRAINING=true"],
      env: { SFU_START_DRAINING: "true" },
      journals: { "sfu-a": { phase: "idle", lkg: "sha256:target" }, "sfu-b": { phase: "idle", lkg: "sha256:target" } },
    });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /sfu-a already runs .* leaving it alone/);
    assert.match(result.output, /sfu-b already runs .* leaving it alone/);
    assert.equal(sfus["sfu-a"].recreates.length + sfus["sfu-b"].recreates.length, 0);
  });
});

// --- Greptile on 0a1f06a7 and 4661b731.

test("a build that fails its last check after calls joined it is drained before any rollback, and left alone while they run", async () => {
  // Once the build serves, a caller joins; then its public route fails, so
  // the deploy must not restart it under that call.
  const onRecreate = (sfu) => {
    if (sfu.image === "sha256:target" && !sfu.draining) {
      sfu.rooms = 1;
      sfu.publicDown = true;
    }
  };
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { rooms: 0, publicRoute: true, onRecreate } }, async (sfus) => {
    const result = await deploy(sfus, { env: { SFU_DEPLOY_SERVICES: "sfu-b" } });
    assert.equal(result.code, 3, result.output);
    assert.deepEqual(sfus["sfu-b"].recreates.map((recreate) => recreate.roomsCut), [0, 0], "no call was cut");
    assert.equal(sfus["sfu-b"].rooms, 1);
    assert.equal(sfus["sfu-b"].draining, true);
  });
});

test("a drain whose reply is lost and that /status cannot confirm is undone, and the journal stays pending until it is", async () => {
  await withSfus({ "sfu-a": { dropDrainReply: true }, "sfu-b": { rooms: 1 } }, async (sfus, events, context) => {
    const shared = await sharedRun("deploy-drain-");
    try {
      context.beforeDrain = async () => {
        sfus["sfu-a"].statusAnswers = false;
      };
      const result = await deploy(sfus, { env: shared.env });
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /Failed to drain sfu-a/);
      assert.equal(sfus["sfu-a"].draining, false, "the drain the SFU applied was undone");
      assert.equal(sfus["sfu-a"].recreates.length, 0);
      const journal = JSON.parse(await readFile(path.join(shared.env.SFU_DEPLOY_STATE_DIR, "vm.sfu-a.journal.json"), "utf8"));
      assert.equal(journal.phase, "drained");
    } finally {
      await rm(shared.dir, { recursive: true, force: true });
    }
  });
});

test("a drain whose reply is lost but that /status confirms counts as applied", async () => {
  await withSfus({ "sfu-a": { dropDrainReply: true }, "sfu-b": { rooms: 1 } }, async (sfus) => {
    const result = await deploy(sfus, { env: { SFU_DEPLOY_SERVICES: "sfu-a" } });
    assert.equal(result.code, 0, result.output);
    assert.equal(sfus["sfu-a"].image, "sha256:target");
    assert.equal(sfus["sfu-a"].draining, false);
    assert.deepEqual(cutRooms(sfus), cutRooms(sfus).map(() => 0));
  });
});

test("on a host whose images carry other names, each service's tag is seeded from its last-known-good image first", async () => {
  // A deploy dies right after its first drain; then an operator runs plain
  // compose up. Compose must start the image that served, not build the
  // unchecked checkout.
  await withSfus({ "sfu-a": {}, "sfu-b": { rooms: 1 } }, async (sfus) => {
    const shared = await sharedRun("deploy-seed-");
    try {
      const env = { ...shared.env, DEPLOY_TEST_UNTAGGED_SERVICE_BUILDS: "1" };
      const first = await deploy(sfus, { env: { ...env, SFU_DEPLOY_TEST_CRASH_AT: "drain sfu-a" } });
      assert.equal(first.code, null, first.output);
      for (const service of ["sfu-a", "sfu-b"]) {
        await composeUpByHand(sfus, { tags: shared.env.DEPLOY_TEST_DOCKER_TAGS, dir: path.join(shared.dir, "by-hand"), env: { DEPLOY_TEST_UNTAGGED_SERVICE_BUILDS: "1" } }, service);
        assert.equal(sfus[service].image, "sha256:running", `${service} came up on the image it served on`);
      }
    } finally {
      await rm(shared.dir, { recursive: true, force: true });
    }
  });
});

// Every test above has its own fake SFUs, state dir, lock file and docker
// stand-in, and its waits are cut short in deploy(), so they run side by side.
describe("deploy-sfu.sh", { concurrency: 8 }, () => {
  for (const args of queued) nodeTest(...args);
});
