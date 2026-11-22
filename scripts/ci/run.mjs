import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { jobs, repoRoot, taskCommand, taskName } from "./jobs.mjs";

const jobName = process.argv[2];
const job = jobs[jobName];
if (!job) {
  console.error(`usage: node scripts/ci/run.mjs <${Object.keys(jobs).join("|")}>`);
  process.exit(2);
}

const startedAt = Number(process.env.CI_JOB_STARTED_AT) || Date.now();
const github = process.env.GITHUB_ACTIONS === "true";

function run(task) {
  const command = taskCommand(task);
  const began = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: repoRoot, shell: true, env: { ...process.env, FORCE_COLOR: "1" } });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("close", (code, signal) => {
      resolve({
        name: taskName(task),
        command,
        code: code ?? 1,
        signal,
        seconds: (Date.now() - began) / 1000,
        output: Buffer.concat(chunks).toString(),
      });
    });
  });
}

function report(result) {
  const status = result.code === 0 ? "ok" : `FAILED (${result.signal ?? `exit ${result.code}`})`;
  const title = `${result.name}: ${status} in ${result.seconds.toFixed(1)}s`;
  if (github) console.log(`::group::${title}`);
  else console.log(`\n=== ${title}`);
  console.log(`$ ${result.command}`);
  process.stdout.write(result.output);
  if (github) console.log("::endgroup::");
}

async function runAll(tasks, limit) {
  const queue = [...tasks];
  const results = [];
  const worker = async () => {
    for (let task = queue.shift(); task; task = queue.shift()) {
      const result = await run(task);
      report(result);
      results.push(result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

const results = [];
for (const task of job.before ?? []) {
  const result = await run(task);
  report(result);
  results.push(result);
}
if (results.every((result) => result.code === 0)) {
  results.push(...(await runAll(job.tasks, Number(process.env.CI_TASK_CONCURRENCY) || availableParallelism())));
}

const elapsed = (Date.now() - startedAt) / 1000;
const failures = results.filter((result) => result.code !== 0);
const overBudget = elapsed > job.budgetSeconds;
const skipped = job.tasks.length + (job.before?.length ?? 0) - results.length;

const lines = [
  `### ${jobName}: ${failures.length ? `${failures.length} failed` : "all passed"}, ${elapsed.toFixed(1)}s of a ${job.budgetSeconds}s budget`,
  "",
  "| task | result | seconds |",
  "| --- | --- | ---: |",
  ...results
    .sort((a, b) => b.seconds - a.seconds)
    .map((result) => `| ${result.name} | ${result.code === 0 ? "ok" : "FAILED"} | ${result.seconds.toFixed(1)} |`),
];
if (skipped) lines.push("", `${skipped} tasks did not start because a setup task failed.`);
console.log(`\n${lines.join("\n")}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);

for (const failure of failures) {
  const message = `${failure.name} failed (${failure.signal ?? `exit ${failure.code}`}): ${failure.command}`;
  console.log(github ? `::error title=${jobName}::${message}` : `FAILED ${message}`);
}
if (overBudget) {
  const message = `${jobName} took ${elapsed.toFixed(1)}s, over its ${job.budgetSeconds}s budget in scripts/ci/jobs.mjs`;
  console.log(github ? `::error title=${jobName} budget::${message}` : `OVER BUDGET ${message}`);
}
process.exit(failures.length || overBudget || skipped ? 1 : 0);
