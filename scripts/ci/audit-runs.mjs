import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    repo: { type: "string", default: "ACM-VIT/conclave" },
    workflow: { type: "string", default: "ci.yml" },
    runs: { type: "string", default: "150" },
    event: { type: "string" },
    "work-step": { type: "string", default: "scripts/ci/run\\.mjs" },
  },
});

const gh = (endpoint) => JSON.parse(execFileSync("gh", ["api", endpoint], { encoding: "utf8", maxBuffer: 64 << 20 }));
const seconds = (from, to) => (Date.parse(to) - Date.parse(from)) / 1000;
const pct = (xs, p) => {
  if (!xs.length) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
};
const workStep = new RegExp(values["work-step"]);

const wanted = Number(values.runs);
const runs = [];
for (let page = 1; runs.length < wanted; page++) {
  const query = `per_page=100&page=${page}&status=completed${values.event ? `&event=${values.event}` : ""}`;
  const batch = gh(`repos/${values.repo}/actions/workflows/${values.workflow}/runs?${query}`).workflow_runs;
  if (!batch.length) break;
  runs.push(...batch.filter((run) => run.conclusion !== "cancelled" && run.conclusion !== "skipped"));
}
runs.length = Math.min(runs.length, wanted);

const buckets = { waiting: [], setup: [], running: [], after: [] };
const perJob = new Map();
const result = [];
for (const run of runs) {
  const jobs = gh(`repos/${values.repo}/actions/runs/${run.id}/jobs?per_page=100`).jobs.filter((job) => job.started_at && job.completed_at && job.conclusion !== "skipped");
  if (!jobs.length) continue;
  for (const job of jobs) {
    const waiting = Math.max(0, seconds(job.created_at, job.started_at));
    const steps = job.steps.filter((step) => step.started_at && step.completed_at);
    const workIndex = steps.findIndex((step) => workStep.test(step.name));
    const span = (list) => (list.length ? seconds(list[0].started_at, list.at(-1).completed_at) : 0);
    const setup = workIndex < 0 ? span(steps) : span(steps.slice(0, workIndex));
    const running = workIndex < 0 ? 0 : span([steps[workIndex]]);
    const after = workIndex < 0 ? 0 : span(steps.slice(workIndex + 1));
    for (const [bucket, value] of Object.entries({ waiting, setup, running, after })) buckets[bucket].push(value);
    const name = job.name.replace(/\s+/g, " ");
    if (!perJob.has(name)) perJob.set(name, { total: [], waiting: [], setup: [], running: [] });
    const entry = perJob.get(name);
    entry.total.push(waiting + seconds(job.started_at, job.completed_at));
    entry.waiting.push(waiting);
    entry.setup.push(setup);
    entry.running.push(running);
  }
  result.push(seconds(run.created_at, jobs.map((job) => job.completed_at).sort().at(-1)));
}

const fmt = (x) => (Number.isNaN(x) ? "-" : x.toFixed(1));
console.log(`${values.repo} ${values.workflow}: ${result.length} completed runs${values.event ? ` (${values.event})` : ""}`);
console.log(`time to result  p50 ${fmt(pct(result, 0.5))}s  p95 ${fmt(pct(result, 0.95))}s`);
console.log("\nbucket\tp50_s\tp95_s\tsum_s");
for (const [bucket, xs] of Object.entries(buckets)) {
  console.log(`${bucket}\t${fmt(pct(xs, 0.5))}\t${fmt(pct(xs, 0.95))}\t${fmt(xs.reduce((a, b) => a + b, 0))}`);
}
console.log("\njob\truns\ttotal_p50\ttotal_p95\twaiting_p50\tsetup_p50\trunning_p50\trunning_p95");
for (const [name, entry] of [...perJob].sort((a, b) => pct(b[1].total, 0.5) - pct(a[1].total, 0.5))) {
  console.log([name, entry.total.length, ...[pct(entry.total, 0.5), pct(entry.total, 0.95), pct(entry.waiting, 0.5), pct(entry.setup, 0.5), pct(entry.running, 0.5), pct(entry.running, 0.95)].map(fmt)].join("\t"));
}
