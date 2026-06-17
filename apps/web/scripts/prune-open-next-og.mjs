import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ogDir = path.join(
  process.cwd(),
  ".open-next/server-functions/default/node_modules/next/dist/compiled/@vercel/og",
);

const emptyWasmModule = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

await mkdir(ogDir, { recursive: true });

await Promise.all([
  writeFile(path.join(ogDir, "resvg.wasm"), emptyWasmModule),
  writeFile(path.join(ogDir, "yoga.wasm"), emptyWasmModule),
  writeFile(path.join(ogDir, "Geist-Regular.ttf.bin"), ""),
]);
