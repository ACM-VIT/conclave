Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
await import(new URL("../../server/apps/documents/worker.ts", import.meta.url).href);
