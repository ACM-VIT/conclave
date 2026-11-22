#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractComments, listSourceFiles } from "./extract.mjs";
import { languageOf } from "./policy.mjs";

const END_MARKERS = {
  script: "// END-OF-FILE-MARKER",
  swift: "// END-OF-FILE-MARKER",
  kotlin: "// END-OF-FILE-MARKER",
  css: "/* END-OF-FILE-MARKER */",
  shell: "# END-OF-FILE-MARKER",
  python: "# END-OF-FILE-MARKER",
};

export const filesMissingEndMarker = (repo, files = listSourceFiles(repo)) =>
  files.filter((file) => {
    const marker = END_MARKERS[languageOf(file)];
    const text = `${readFileSync(path.join(repo, file), "utf8")}\n${marker}\n`;
    return extractComments(text, file).at(-1)?.text !== marker;
  });

const main = () => {
  const repo = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const files = listSourceFiles(repo);
  const misses = filesMissingEndMarker(repo, files);
  if (misses.length > 0) {
    console.error(["comment sweep: the extractor lost track of these files before their end:", ...misses.map((file) => `  ${file}`)].join("\n"));
    return 1;
  }
  console.log(`comment sweep: every comment scanner reached the end of all ${files.length} tracked files.`);
  return 0;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`comment sweep: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
