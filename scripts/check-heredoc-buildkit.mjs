import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DockerSession, assertLocalBuilder, localSocket, pinnedDocker, resolveDockerEndpoint } from "./check-docker-images.mjs";
import { BODY_MARKER, HEREDOC_CASES } from "./docker-context/heredoc-cases.mjs";

const BODY_PROBE = "hello world";

export function buildkitProbe(text) {
  return text.replace(/^FROM node$/m, "FROM scratch").replaceAll(BODY_MARKER, BODY_PROBE);
}

export function buildkitVerdict(output) {
  if (/Check complete/.test(output)) return "parsed";
  if (/unterminated heredoc/.test(output)) return "unclosed";
  return `failed: ${output.trim().split("\n").at(-1)}`;
}

async function main() {
  const session = new DockerSession();
  const daemon = localSocket(await resolveDockerEndpoint(process.env, session));
  const docker = pinnedDocker(daemon, process.env, session);
  const builder = await assertLocalBuilder(docker);
  const dir = mkdtempSync(path.join(tmpdir(), "conclave-heredoc-buildkit-"));
  const context = path.join(dir, "context");
  mkdirSync(context);
  const mismatches = [];
  let compared = 0;
  try {
    for (const row of HEREDOC_CASES.filter((item) => !item.unsupported)) {
      const file = path.join(dir, `${compared}.Dockerfile`);
      writeFileSync(file, buildkitProbe(row.text));
      const result = await docker(["buildx", "build", "--builder", builder, "--call=check", "-f", file, context], { allowFailure: true });
      const verdict = buildkitVerdict(`${result.stdout}${result.stderr}`);
      const expected = row.unclosed ? "unclosed" : "parsed";
      if (verdict !== expected) mismatches.push(`${row.name}: the guard expects ${expected}, BuildKit says ${verdict}`);
      compared += 1;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const mismatch of mismatches) console.error(mismatch);
  const skipped = HEREDOC_CASES.length - compared;
  console.log(`${compared - mismatches.length} of ${compared} heredoc rows match BuildKit on ${daemon.host}; ${skipped} unsupported rows are guard errors and not compared`);
  return mismatches.length === 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (ok) => {
      process.exitCode = ok ? 0 : 1;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
