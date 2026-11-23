import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { problems, singletonProblems, sourceProblems, testProblems } from "./check-native-test-stores.mjs";

test("the native tests and sources keep off the shared preferences store", () => {
  assert.deepEqual(problems(), []);
});

test("a test that names the shared store fails on that line", () => {
  const found = testProblems("T.swift", "let a = 1\nlet defaults = UserDefaults.standard\n");
  assert.deepEqual(found.map(({ line }) => line), [2]);
});

test("a test that passes .standard as a store fails", () => {
  assert.equal(testProblems("T.swift", "MeetingResumeMarker.read(defaults: .standard)").length, 1);
});

test("a test that reaches a singleton built on the shared store fails", () => {
  for (const use of ["AppState.shared.currentUser", "MeetingViewModel.shared", "SystemNotifications.shared.snapshot",
    "AppearancePreference.shared.mode", "LocalVideoMirrorPreference.shared.isOn", "ConclaveFeedbackPlayer.shared"]) {
    assert.equal(testProblems("T.swift", use).length, 1, use);
  }
});

test("a test on a private store passes", () => {
  const text = [
    "let viewModel = isolatedViewModel()",
    "let shell = MeetingShellPresenter(defaults: IsolatedDefaults.make())",
    "let defaults = UserDefaults(suiteName: suite)!",
    "let kind = VoiceKind.standard",
    "let state = AppState(defaults: defaults)",
  ].join("\n");
  assert.deepEqual(testProblems("T.swift", text), []);
});

test("a source API that defaults its store to the shared one fails", () => {
  assert.equal(sourceProblems("S.swift", "init(defaults: UserDefaults = .standard) {").length, 1);
  assert.equal(sourceProblems("S.swift", "static func load(defaults: UserDefaults = UserDefaults.standard) -> X").length, 1);
  assert.deepEqual(sourceProblems("S.swift", "static let shared = AppState(defaults: UserDefaults.standard)"), []);
});

test("the singleton list fails once a listed singleton stops using the shared store", () => {
  const sources = [
    { file: "A.swift", text: "final class AppState {\n    static let shared = AppState(defaults: UserDefaults.standard)\n}" },
  ];
  const missing = singletonProblems(sources).map(({ reason }) => reason.split(".shared")[0]);
  assert.deepEqual(missing, ["MeetingViewModel", "SystemNotifications", "AppearancePreference", "LocalVideoMirrorPreference",
    "ConclaveFeedbackPlayer"]);
});

test("the check walks nested test folders", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-test-stores-"));
  try {
    const nested = path.join(root, "apps/conclave-skip/Tests/ConclaveTests/Deep");
    await mkdir(nested, { recursive: true });
    await mkdir(path.join(root, "apps/conclave-skip/Sources"), { recursive: true });
    await writeFile(path.join(nested, "Leak.swift"), "let d = UserDefaults.standard\n");
    const found = problems(root).filter(({ file }) => file.endsWith("Leak.swift"));
    assert.deepEqual(found.map(({ file, line }) => `${file}:${line}`), ["apps/conclave-skip/Tests/ConclaveTests/Deep/Leak.swift:1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
