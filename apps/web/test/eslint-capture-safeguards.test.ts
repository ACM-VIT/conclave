import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const eslint = new ESLint({ cwd });
const syntaxLinter = new ESLint({
  cwd,
  overrideConfig: { languageOptions: { parserOptions: { projectService: false } } },
  ruleFilter: ({ ruleId }) => ruleId === "no-restricted-syntax",
});
const captures = "src/app/lib/media-captures.ts";
const socket = "src/app/hooks/useMeetSocket.ts";
const ui = "src/app/components/JoinScreen.tsx";
const js = "src/app/fixture.js";
const jsx = "src/app/fixture.jsx";
const effectiveRule = async (file: string) =>
  (await eslint.calculateConfigForFile(file)).rules["no-restricted-syntax"];

const fixture = `
  const output = new Error(answer.error);
  console.error("[Meets] A call failed");
  navigator.mediaDevices.getUserMedia({ audio: true });
  navigator.mediaDevices.getDisplayMedia({ video: true });
  context.createMediaStreamDestination();
  canvas.captureStream();
  new MediaStreamTrackGenerator();
  track.clone();
`;

it.each([[socket, 6], [ui, 6], [captures, 2], [js, 4], [jsx, 4]] as const)(
  "enforces the intended restricted selectors in %s",
  async (file, count) => {
    expect(await effectiveRule(file)).toHaveLength(count + 1);
  },
);

it.each([
  [socket, [2, 3, 4, 5, 6, 7, 8, 9]],
  [ui, [2, 3, 4, 5, 6, 7, 8, 9]],
  [captures, [2, 3]],
  [js, [4, 5, 6, 7, 8, 9]],
  [jsx, [4, 5, 6, 7, 8, 9]],
] as const)("reports the right errors in %s", async (filePath, lines) => {
  const [result] = await syntaxLinter.lintText(fixture, { filePath });
  expect(result.messages.filter(({ fatal }) => fatal)).toEqual([]);
  const violations = result.messages.filter(({ ruleId }) => ruleId === "no-restricted-syntax");
  expect(violations.map(({ line }) => line)).toEqual(lines);
  expect(violations.every(({ severity }) => severity === 2)).toBe(true);
});
