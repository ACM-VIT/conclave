import { installCommentTools } from "./tokenizers.mjs";

const report = installCommentTools();
for (const { ok, line } of report) (ok ? console.log : console.error)(line);
process.exitCode = report.every(({ ok }) => ok) ? 0 : 1;
