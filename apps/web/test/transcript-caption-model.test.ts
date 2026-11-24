import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPTION_GAP_MARKER as GAP,
  TRANSCRIPTION_LINE_DEADLINE_MS as DEADLINE,
  TRANSCRIPTION_RECOVERY_MAX_AUDIO_BYTES as REPLAY_AUDIO_LIMIT,
} from "../transcript-worker/src/constants";
import {
  AUDIO,
  OPENAI,
  SARVAM,
  openAiCommitted,
  openAiFinal,
  sarvamFinal,
  sarvamSpeechStart,
  settle,
  transcriptRoomRig,
} from "./transcript-room-rig";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("@conclave/ai/room-server", async (original) => ({
  ...(await original<typeof import("@conclave/ai/room-server")>()),
  fetchRoomAiEnvironment: lookup,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type Rig = Awaited<ReturnType<typeof transcriptRoomRig>>;
type Outcome = { shown: [string, string | undefined][]; replayedChunks?: number; bufferedBytes?: number };

const ada = { userId: "ada", displayName: "Ada" };
const grace = { userId: "grace", displayName: "Grace" };
const audioMessages = (socket: { sent: Record<string, unknown>[] }) =>
  socket.sent.filter((message) => {
    const audio = (message as { audio?: unknown }).audio;
    return typeof audio === "string" || Boolean((audio as { data?: string } | undefined)?.data);
  }).length;
const shown = (rig: Rig) =>
  rig.room.segments.map(({ text, speakerUserId }) => [text, speakerUserId] as [string, string | undefined]);
const bufferedBytes = (rig: Rig) =>
  (rig.room as unknown as { transcriptionRecoveryAudio: { bytes: number } }).transcriptionRecoveryAudio.bytes;

const signalsActive = async (rig: Rig) => {
  const [socket] = rig.providerSockets();
  await rig.speak(grace);
  socket.emit(sarvamSpeechStart());
  await rig.endTurn(grace);
  socket.emit(sarvamFinal("setup", "Setup."));
  await vi.advanceTimersByTimeAsync(2_000);
  return socket;
};

const cases: { thread: string; model: string; run: (rig: Rig) => Promise<Outcome> }[] = [
  {
    thread: "Replay signals hide new speech",
    model: SARVAM,
    async run(rig) {
      const [socket] = rig.providerSockets();
      for (const speaker of [ada, grace]) {
        await rig.speak(speaker);
        socket.emit(sarvamSpeechStart());
        await rig.endTurn(speaker);
      }
      socket.disconnect();
      await settle();
      const replacement = rig.providerSockets().at(-1)!;
      replacement.emit(sarvamSpeechStart());
      await rig.speak(ada);
      await rig.endTurn(ada);
      replacement.emit(sarvamSpeechStart());
      replacement.emit(sarvamSpeechStart());
      replacement.emit(sarvamFinal("a", "Ada replayed."));
      replacement.emit(sarvamFinal("g", "Grace replayed."));
      await vi.advanceTimersByTimeAsync(DEADLINE + 100);
      return { shown: shown(rig) };
    },
  },
  {
    thread: "Soft speech vanishes on reconnect",
    model: OPENAI,
    async run(rig) {
      const [socket] = rig.providerSockets();
      await rig.sendAudio("whisper", ada);
      socket.disconnect();
      await settle();
      const replacement = rig.providerSockets().at(-1)!;
      const replayedChunks = audioMessages(replacement);
      replacement.emit(openAiCommitted("r"));
      replacement.emit(openAiFinal("r", "Soft words."));
      await settle();
      return { shown: shown(rig), replayedChunks };
    },
  },
  {
    thread: "Older audio blocks new speech",
    model: OPENAI,
    async run(rig) {
      const [socket] = rig.providerSockets();
      const owedChunks = Math.floor((0.95 * REPLAY_AUDIO_LIMIT) / AUDIO.speech.length);
      for (let index = 0; index < owedChunks; index += 1) {
        await rig.speak(ada);
        await vi.advanceTimersByTimeAsync(20);
      }
      await rig.commit(ada);
      socket.emit(openAiCommitted("a"));
      rig.connectPlans.push(...Array<"unreachable">(30).fill("unreachable"));
      socket.disconnect();
      await settle();
      const newChunks = Math.ceil((0.3 * REPLAY_AUDIO_LIMIT) / AUDIO.speech.length);
      for (let index = 0; index < newChunks; index += 1) {
        await rig.speak(grace);
        await vi.advanceTimersByTimeAsync(20);
      }
      return { shown: [], bufferedBytes: Math.min(bufferedBytes(rig), newChunks * AUDIO.speech.length) };
    },
  },
  {
    thread: "Returning speakers lose replay audio",
    model: SARVAM,
    async run(rig) {
      const socket = await signalsActive(rig);
      await rig.speak(ada);
      socket.emit(sarvamSpeechStart());
      await vi.advanceTimersByTimeAsync(100);
      await rig.speak(grace);
      socket.emit(sarvamSpeechStart());
      await vi.advanceTimersByTimeAsync(100);
      await rig.speak(ada);
      socket.emit(sarvamFinal("one", "Ada one."));
      socket.emit(sarvamSpeechStart());
      await rig.endTurn(ada);
      socket.disconnect();
      await settle();
      const replacement = rig.providerSockets().at(-1)!;
      const replayedChunks = audioMessages(replacement);
      replacement.emit(sarvamSpeechStart());
      replacement.emit(sarvamSpeechStart());
      replacement.emit(sarvamFinal("g", "Grace words."));
      replacement.emit(sarvamFinal("a", "Ada again."));
      await vi.advanceTimersByTimeAsync(DEADLINE + 100);
      return { shown: shown(rig), replayedChunks };
    },
  },
  {
    thread: "Delayed signals hide speech",
    model: SARVAM,
    async run(rig) {
      const socket = await signalsActive(rig);
      await rig.speak(ada);
      for (const _ of [1, 2, 3, 4]) {
        await vi.advanceTimersByTimeAsync(200);
        await rig.sendAudio("silence", ada);
      }
      await vi.advanceTimersByTimeAsync(200);
      await rig.speak(ada);
      await rig.endTurn(ada);
      await vi.advanceTimersByTimeAsync(300);
      socket.emit(sarvamSpeechStart());
      socket.emit(sarvamSpeechStart());
      await vi.advanceTimersByTimeAsync(DEADLINE + 100);
      return { shown: shown(rig) };
    },
  },
  {
    thread: "Empty answers leave false gaps",
    model: OPENAI,
    async run(rig) {
      const [socket] = rig.providerSockets();
      await rig.speak(ada);
      await rig.commit(ada);
      await vi.advanceTimersByTimeAsync(DEADLINE + 1_000);
      socket.emit(openAiCommitted("a"));
      socket.emit(openAiFinal("a", ""));
      await settle();
      expect(rig.viewerTranscript().segments).toEqual([]);
      return { shown: shown(rig) };
    },
  },
  {
    thread: "Same-tick speech disappears",
    model: SARVAM,
    async run(rig) {
      const socket = await signalsActive(rig);
      socket.emit(sarvamSpeechStart());
      await rig.speak(ada);
      await rig.endTurn(ada);
      await vi.advanceTimersByTimeAsync(DEADLINE + 100);
      return { shown: shown(rig) };
    },
  },
  {
    thread: "Resolving speech hides another speaker",
    model: SARVAM,
    async run(rig) {
      const socket = await signalsActive(rig);
      socket.emit(sarvamSpeechStart());
      await vi.advanceTimersByTimeAsync(50);
      await rig.speak(ada);
      await rig.endTurn(ada);
      await rig.speak(grace);
      await rig.endTurn(grace);
      socket.emit(sarvamFinal("one", "Ada words."));
      await vi.advanceTimersByTimeAsync(300);
      socket.emit(sarvamSpeechStart());
      await vi.advanceTimersByTimeAsync(DEADLINE + 100);
      return { shown: shown(rig) };
    },
  },
  {
    thread: "Delayed claims steal later audio",
    model: SARVAM,
    async run(rig) {
      const socket = await signalsActive(rig);
      await rig.speak(ada);
      await vi.advanceTimersByTimeAsync(100);
      await rig.speak(grace);
      await vi.advanceTimersByTimeAsync(100);
      await rig.speak(ada);
      await vi.advanceTimersByTimeAsync(300);
      for (const _ of [1, 2, 3]) socket.emit(sarvamSpeechStart());
      socket.emit(sarvamFinal("one", "Ada one."));
      await rig.endTurn(ada);
      socket.disconnect();
      await settle();
      const replacement = rig.providerSockets().at(-1)!;
      const replayedChunks = audioMessages(replacement);
      replacement.emit(sarvamSpeechStart());
      replacement.emit(sarvamSpeechStart());
      replacement.emit(sarvamFinal("g", "Grace words."));
      replacement.emit(sarvamFinal("a", "Ada again."));
      await vi.advanceTimersByTimeAsync(DEADLINE + 100);
      return { shown: shown(rig), replayedChunks };
    },
  },
  {
    thread: "Late signals miss ongoing speech",
    model: SARVAM,
    async run(rig) {
      const socket = await signalsActive(rig);
      for (let elapsed = 0; elapsed <= 2_500; elapsed += 250) {
        await rig.speak(ada);
        await vi.advanceTimersByTimeAsync(250);
      }
      socket.emit(sarvamSpeechStart());
      await rig.endTurn(ada);
      await vi.advanceTimersByTimeAsync(DEADLINE + 100);
      return { shown: shown(rig) };
    },
  },
  {
    thread: "Brief drops end recoverable captions",
    model: OPENAI,
    async run(rig) {
      const [socket] = rig.providerSockets();
      await rig.speak(ada);
      await rig.commit(ada);
      socket.emit(openAiCommitted("a"));
      socket.disconnect();
      await settle();
      rig.providerSockets().at(-1)!.disconnect();
      await settle();
      const replacement = rig.providerSockets().at(-1)!;
      const replayedChunks = audioMessages(replacement);
      replacement.emit(openAiCommitted("r"));
      replacement.emit(openAiFinal("r", "Recovered."));
      await settle();
      return { shown: shown(rig), replayedChunks };
    },
  },
  {
    thread: "Short turns lose replay audio",
    model: SARVAM,
    async run(rig) {
      const socket = await signalsActive(rig);
      const send = socket.send.bind(socket);
      socket.send = (raw: string) => {
        send(raw);
        vi.setSystemTime(Date.now() + 5);
      };
      await rig.speak(ada);
      await rig.endTurn(ada);
      await vi.advanceTimersByTimeAsync(300);
      socket.emit(sarvamSpeechStart());
      socket.disconnect();
      await settle();
      const replacement = rig.providerSockets().at(-1)!;
      const replayedChunks = audioMessages(replacement);
      replacement.emit(sarvamSpeechStart());
      replacement.emit(sarvamFinal("a", "Ada short."));
      await vi.advanceTimersByTimeAsync(DEADLINE + 100);
      return { shown: shown(rig), replayedChunks };
    },
  },
  {
    thread: "Replays change speaking order",
    model: SARVAM,
    async run(rig) {
      const socket = await signalsActive(rig);
      for (const speaker of [ada, grace, ada]) {
        await rig.speak(speaker);
        await rig.endTurn(speaker);
        await vi.advanceTimersByTimeAsync(200);
      }
      socket.disconnect();
      await settle();
      const replacement = rig.providerSockets().at(-1)!;
      const replayedChunks = audioMessages(replacement);
      for (const [id, text] of [["1", "Ada first."], ["2", "Grace second."], ["3", "Ada third."]]) {
        replacement.emit(sarvamSpeechStart());
        replacement.emit(sarvamFinal(id, text));
      }
      await vi.advanceTimersByTimeAsync(DEADLINE + 100);
      return { shown: shown(rig), replayedChunks };
    },
  },
];

const expected: Record<string, Outcome> = {
  "Replay signals hide new speech": {
    shown: [["Ada replayed.", "ada"], ["Grace replayed.", "grace"], [GAP, "ada"]],
  },
  "Soft speech vanishes on reconnect": { shown: [["Soft words.", "ada"]], replayedChunks: 1 },
  "Older audio blocks new speech": {
    shown: [],
    bufferedBytes: Math.ceil((0.3 * REPLAY_AUDIO_LIMIT) / AUDIO.speech.length) * AUDIO.speech.length,
  },
  "Returning speakers lose replay audio": {
    shown: [["Setup.", "grace"], ["Ada one.", "ada"], ["Grace words.", "grace"], ["Ada again.", "ada"]],
    replayedChunks: 2,
  },
  "Delayed signals hide speech": { shown: [["Setup.", "grace"], [GAP, "ada"], [GAP, "ada"]] },
  "Empty answers leave false gaps": { shown: [] },
  "Same-tick speech disappears": { shown: [["Setup.", "grace"], [GAP, "ada"]] },
  "Resolving speech hides another speaker": {
    shown: [["Setup.", "grace"], ["Ada words.", "ada"], [GAP, "grace"]],
  },
  "Delayed claims steal later audio": {
    shown: [["Setup.", "grace"], ["Ada one.", "ada"], ["Grace words.", "grace"], ["Ada again.", "ada"]],
    replayedChunks: 2,
  },
  "Late signals miss ongoing speech": { shown: [["Setup.", "grace"], [GAP, "ada"]] },
  "Brief drops end recoverable captions": { shown: [["Recovered.", "ada"]], replayedChunks: 1 },
  "Short turns lose replay audio": { shown: [["Setup.", "grace"], ["Ada short.", "ada"]], replayedChunks: 1 },
  "Replays change speaking order": {
    shown: [["Setup.", "grace"], ["Ada first.", "ada"], ["Grace second.", "grace"], ["Ada third.", "ada"]],
    replayedChunks: 3,
  },
};

describe("the caption model: what each signal claims, what is shown and what is replayed", () => {
  it.each(cases.map((testCase) => [testCase.thread, testCase] as const))("%s", async (_, testCase) => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rig = await transcriptRoomRig(lookup, testCase.model);
    await rig.start(testCase.model === OPENAI ? "en" : "hi");
    expect(await testCase.run(rig)).toEqual(expected[testCase.thread]);
  });
});
