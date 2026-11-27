// Bundles the deploy canary into one file with all of its dependencies
// inside, so an SFU image installed without dev dependencies can still run
// it: `node dist/canary-call.mjs --url ...`.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const outfile = process.argv[2] ?? fileURLToPath(new URL("../dist/canary-call.mjs", import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL("./canary-call.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile,
  // CommonJS dependencies inside an ES module bundle still call require().
  banner: { js: "import { createRequire as __canaryRequire } from 'node:module'; const require = __canaryRequire(import.meta.url);" },
  logLevel: "warning",
});
