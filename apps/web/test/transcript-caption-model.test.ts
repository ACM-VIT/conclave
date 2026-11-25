import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SARVAM_REPLAY_SETTLE_MS as SETTLE,
  TRANSCRIPTION_GAP_MARKER as GAP,
  TRANSCRIPTION_LINE_DEADLINE_MS as DEADLINE,
  TRANSCRIPTION_RECOVERY_MAX_AUDIO_BYTES as REPLAY_AUDIO_LIMIT,
} from "../transcript-worker/src/constants";
import {
  AUDIO,
  OPENAI,
  SARVAM,
  answerSarvamReplays,
  openAiCommitted,
  openAiDelta,
  openAiFinal,
  sarvamFinal,
  sarvamSpeechEnd,
  sarvamSpeechStart,
  settle,
  transcriptRoomRig,
} from "./transcript-room-rig";
import { pcmBase64, voicedPcm } from "./transcript-audio-fixtures";

const LONG_SPEECH = pcmBase64(voicedPcm(-26, 700));

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
type Outcome = {
  shown: [string, string | undefined][];
  replayedChunks?: number;
  bufferedBytes?: number;
  saved?: string[];
  threw?: boolean;
  supersededChunks?: number;
  forwarded?: number;
  status?: string;
  opened?: number;
  oldProviderAudio?: number;
  restarted?: string[];
  retained?: { linesWithinCap: boolean; mappingsWithinCap: boolean; lines: number };
};

const ada = { userId: "ada", displayName: "Ada" };
const grace = { userId: "grace", displayName: "Grace" };
const audioMessages = (socket: { sent: Record<string, unknown>[] }) =>
  socket.sent.filter((message) => {
    const audio = (message as { audio?: unknown }).audio;
    return typeof audio === "string" || Boolean((audio as { data?: string } | undefined)?.data);
  }).length;
const shown = (rig: Rig) =>
  rig.viewerTranscript().segments.map(({ text, speakerUserId }) => [text, speakerUserId] as [string, string | undefined]);
const forwardedTo = (sockets: { sent: Record<string, unknown>[] }[]) =>
  sockets.reduce(
    (sum, socket) =>
      sum + audioMessages(socket) + socket.sent.filter(({ type }) => String(type).includes("commit")).length,
    0,
  );
const bufferedBytes = (rig: Rig) =>
  (rig.room as unknown as { audio: { queued(): { audio: string }[] } }).audio
    .queued()
    .reduce((sum, { audio }) => sum + audio.length, 0);

const replayedOnLanes = async (rig: Rig, speakers: readonly { userId: string; displayName: string }[]) => {
  let total = 0;
  for (const speaker of speakers) total += audioMessages(await rig.lane(speaker));
  return total;
};

const signalsActive = async (rig: Rig) => {
  const [socket] = rig.providerSockets();
  await rig.speak(grace);
  socket.emit(sarvamSpeechStart());
  await rig.endTurn(grace);
  socket.emit(sarvamFinal("setup", "Setup."));
  await vi.advanceTimersByTimeAsync(2_000);
  return socket;
};

const cases: { thread: string; model: string; env?: Record<string, string>; run: (rig: Rig) => Promise<Outcome> }[] = [
  {
    thread: "Replay signals hide new speech",
    model: SARVAM,
    async run(rig) {
      for (const speaker of [ada, grace]) {
        await rig.speak(speaker);
        (await rig.lane(speaker)).emit(sarvamSpeechStart());
        await rig.endTurn(speaker);
      }
      (await rig.lane(ada)).disconnect();
      await settle();
      const adaReplay = await rig.lane(ada);
      adaReplay.emit(sarvamSpeechStart());
      await rig.speak(ada);
      await rig.endTurn(ada);
      adaReplay.emit(sarvamFinal("a", "Ada replayed."));
      await vi.advanceTimersByTimeAsync(SETTLE + 50);
      const graceReplay = await rig.lane(grace);
      graceReplay.emit(sarvamSpeechStart());
      graceReplay.emit(sarvamFinal("g", "Grace replayed."));
      await vi.advanceTimersByTimeAsync(SETTLE + 50);
      (await rig.lane(ada)).emit(sarvamSpeechStart());
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
      const adaLane = await rig.lane(ada);
      adaLane.emit(sarvamSpeechStart());
      await vi.advanceTimersByTimeAsync(100);
      await rig.speak(grace);
      socket.emit(sarvamSpeechStart());
      await vi.advanceTimersByTimeAsync(100);
      await rig.speak(ada);
      adaLane.emit(sarvamFinal("one", "Ada one."));
      adaLane.emit(sarvamSpeechStart());
      await rig.endTurn(ada);
      socket.disconnect();
      await settle();
      await answerSarvamReplays(rig, [[grace, "g", "Grace words."]]);
      const replayedChunks = await replayedOnLanes(rig, [grace]);
      await vi.advanceTimersByTimeAsync(DEADLINE + 100);
      return { shown: shown(rig), replayedChunks };
    },
  },
  {
    thread: "Delayed signals hide speech",
    model: SARVAM,
    async run(rig) {
      await signalsActive(rig);
      await rig.speak(ada);
      for (const _ of [1, 2, 3, 4]) {
        await vi.advanceTimersByTimeAsync(200);
        await rig.sendAudio("silence", ada);
      }
      await vi.advanceTimersByTimeAsync(200);
      await rig.speak(ada);
      await rig.endTurn(ada);
      await vi.advanceTimersByTimeAsync(300);
      const socket = await rig.lane(ada);
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
      await signalsActive(rig);
      await rig.sendAudio("silence", ada);
      (await rig.lane(ada)).emit(sarvamSpeechStart());
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
      await rig.sendAudio("silence", ada);
      const adaLane = await rig.lane(ada);
      adaLane.emit(sarvamSpeechStart());
      await vi.advanceTimersByTimeAsync(50);
      await rig.speak(ada);
      await rig.endTurn(ada);
      await rig.speak(grace);
      await rig.endTurn(grace);
      adaLane.emit(sarvamFinal("one", "Ada words."));
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
      const adaLane = await rig.lane(ada);
      adaLane.emit(sarvamSpeechStart());
      socket.emit(sarvamSpeechStart());
      adaLane.emit(sarvamSpeechStart());
      adaLane.emit(sarvamFinal("one", "Ada one."));
      await rig.endTurn(ada);
      socket.disconnect();
      await settle();
      await answerSarvamReplays(rig, [[grace, "g", "Grace words."]]);
      const replayedChunks = await replayedOnLanes(rig, [grace]);
      await vi.advanceTimersByTimeAsync(DEADLINE + 100);
      return { shown: shown(rig), replayedChunks };
    },
  },
  {
    thread: "Late signals miss ongoing speech",
    model: SARVAM,
    async run(rig) {
      await signalsActive(rig);
      for (let elapsed = 0; elapsed <= 2_500; elapsed += 250) {
        await rig.speak(ada);
        await vi.advanceTimersByTimeAsync(250);
      }
      (await rig.lane(ada)).emit(sarvamSpeechStart());
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
      await answerSarvamReplays(rig, [
        [ada, "1", "Ada first."],
        [grace, "2", "Grace second."],
        [ada, "3", "Ada third."],
      ]);
      const replayedChunks = await replayedOnLanes(rig, [ada, grace]);
      await vi.advanceTimersByTimeAsync(DEADLINE + 100);
      return { shown: shown(rig), replayedChunks };
    },
  },
  {
    thread: "Recent speech loses its speaker",
    model: SARVAM,
    async run(rig) {
      const socket = await signalsActive(rig);
      for (let chunk = 0; chunk < 27; chunk += 1) {
        await rig.speak(ada);
        await vi.advanceTimersByTimeAsync(150);
      }
      socket.emit(sarvamSpeechStart());
      socket.disconnect();
      await settle();
      const replacement = rig.providerSockets().at(-1)!;
      const replayedChunks = audioMessages(replacement);
      replacement.emit(sarvamSpeechStart());
      replacement.emit(sarvamFinal("a", "Ada long."));
      await vi.advanceTimersByTimeAsync(DEADLINE + 100);
      return { shown: shown(rig), replayedChunks };
    },
  },
  {
    thread: "Same-tick audio changes owners",
    model: SARVAM,
    async run(rig) {
      const socket = await signalsActive(rig);
      await rig.speak(ada);
      await rig.speak(grace);
      await rig.speak(ada);
      (await rig.lane(ada)).emit(sarvamSpeechStart());
      socket.emit(sarvamSpeechStart());
      socket.disconnect();
      await settle();
      await answerSarvamReplays(rig, [
        [ada, "1", "One."],
        [grace, "2", "Two."],
      ]);
      const replayedChunks = await replayedOnLanes(rig, [ada, grace]);
      await vi.advanceTimersByTimeAsync(DEADLINE + 100);
      return { shown: shown(rig), replayedChunks };
    },
  },
  {
    thread: "Shown words are not saved",
    model: OPENAI,
    async run(rig) {
      const [socket] = rig.providerSockets();
      await rig.speak(ada);
      await rig.commit(ada);
      await settle();
      socket.emit(openAiCommitted("a"));
      await settle();
      socket.emit(openAiDelta("a", "Hello there"));
      await settle();
      return { shown: shown(rig), saved: rig.lastSnapshotTexts() };
    },
  },
  {
    thread: "Early starts miss continuing speech",
    model: SARVAM,
    async run(rig) {
      await signalsActive(rig);
      await rig.speak(ada);
      const socket = await rig.lane(ada);
      socket.emit(sarvamSpeechStart());
      socket.emit(sarvamFinal("s", "Short."));
      socket.emit(sarvamSpeechStart());
      for (let chunk = 0; chunk < 3; chunk += 1) {
        await vi.advanceTimersByTimeAsync(100);
        await rig.speak(ada);
      }
      await vi.advanceTimersByTimeAsync(3_500);
      socket.disconnect();
      await settle();
      const replacement = await rig.lane(ada);
      const replayedChunks = audioMessages(replacement);
      replacement.emit(sarvamSpeechStart());
      replacement.emit(sarvamFinal("c", "Continued."));
      await vi.advanceTimersByTimeAsync(DEADLINE + 100);
      return { shown: shown(rig), replayedChunks };
    },
  },
  {
    thread: "Switches can lose buffered speech",
    model: SARVAM,
    async run(rig) {
      const socket = await signalsActive(rig);
      rig.connectPlans.push("unreachable", { lateMs: 1_500 });
      socket.disconnect();
      await settle();
      for (let chunk = 0; chunk < 3; chunk += 1) {
        await rig.speak(ada);
        await vi.advanceTimersByTimeAsync(100);
      }
      rig.saves.before = () => new Promise((resolve) => setTimeout(resolve, 3_000));
      const switching = rig.switchTo("ta");
      await vi.advanceTimersByTimeAsync(4_000);
      await switching;
      rig.saves.before = undefined;
      await settle();
      const [superseded, current] = rig.providerSockets().slice(-2);
      return { shown: [], replayedChunks: audioMessages(current), supersededChunks: audioMessages(superseded) };
    },
  },
  {
    thread: "Corrupt audio escapes error checks",
    model: SARVAM,
    async run(rig) {
      await signalsActive(rig);
      let threw = false;
      for (const audio of ["%%%%", "@@@@AAAA", "A"]) {
        try {
          await rig.send({ type: "audio.chunk", audio, speaker: ada });
        } catch {
          threw = true;
        }
      }
      await rig.speak(ada);
      const adaLane = await rig.lane(ada);
      adaLane.emit(sarvamSpeechStart());
      adaLane.emit(sarvamFinal("a", "Still heard."));
      await settle();
      return { shown: shown(rig), threw };
    },
  },
  {
    thread: "Restored pauses leak audio",
    model: OPENAI,
    async run(rig) {
      await rig.speak(ada);
      await rig.send({ type: "session.pause" });
      await settle();
      rig.connectPlans.push({ lateMs: 1_000 });
      const before = rig.providerSockets().length;
      const restarted = await rig.restart({
        env: { OPENAI_API_KEY: "sk-global" },
        snapshot: (saved) => {
          saved.session.keySource = "global";
        },
      });
      await restarted.send({ type: "audio.chunk", audio: AUDIO.speech, speaker: ada });
      await restarted.send({ type: "audio.commit", speaker: ada });
      await vi.advanceTimersByTimeAsync(1_500);
      await restarted.send({ type: "audio.chunk", audio: AUDIO.speech, speaker: ada });
      await restarted.send({ type: "audio.commit", speaker: ada });
      await settle();
      return {
        shown: [],
        forwarded: forwardedTo(rig.providerSockets().slice(before)),
        status: (restarted.room.session as { status?: string } | null)?.status,
      };
    },
  },
  {
    thread: "Late answers take the next caption",
    model: SARVAM,
    async run(rig) {
      const socket = await signalsActive(rig);
      await rig.speak(ada);
      const adaLane = await rig.lane(ada);
      adaLane.emit(sarvamSpeechStart());
      await rig.endTurn(ada);
      await vi.advanceTimersByTimeAsync(20_000);
      await rig.speak(grace);
      socket.emit(sarvamSpeechStart());
      await rig.endTurn(grace);
      await vi.advanceTimersByTimeAsync(DEADLINE - 20_000 + 1_000);
      adaLane.emit(sarvamFinal("ada-late", "Ada late."));
      socket.emit(sarvamFinal("grace", "Grace late on the old connection."));
      await settle();
      const replacement = await rig.lane(grace);
      replacement.emit(sarvamSpeechStart());
      replacement.emit(sarvamFinal("grace", "Grace words."));
      await vi.advanceTimersByTimeAsync(DEADLINE + 100);
      return { shown: shown(rig) };
    },
  },
  {
    thread: "Repeated answers take the next caption",
    model: SARVAM,
    async run(rig) {
      const socket = await signalsActive(rig);
      await rig.speak(ada);
      const adaLane = await rig.lane(ada);
      adaLane.emit(sarvamSpeechStart());
      await rig.endTurn(ada);
      await vi.advanceTimersByTimeAsync(500);
      await rig.speak(grace);
      socket.emit(sarvamSpeechStart());
      await rig.endTurn(grace);
      adaLane.emit(sarvamFinal("ada", "Ada words."));
      adaLane.emit(sarvamFinal("ada", "Ada words."));
      socket.emit(sarvamFinal("grace", "Grace words."));
      await vi.advanceTimersByTimeAsync(DEADLINE + 100);
      return { shown: shown(rig) };
    },
  },
  {
    thread: "Replays land after later finals",
    model: SARVAM,
    async run(rig) {
      const socket = await signalsActive(rig);
      await rig.speak(ada);
      await rig.speak(ada);
      await vi.advanceTimersByTimeAsync(2_000);
      await rig.speak(grace);
      socket.emit(sarvamSpeechStart());
      socket.emit(sarvamFinal("g", "Grace words."));
      await settle();
      socket.disconnect();
      await settle();
      await answerSarvamReplays(rig, [[ada, "a", "Ada words."]]);
      await vi.advanceTimersByTimeAsync(DEADLINE + 100);
      return { shown: shown(rig), saved: rig.lastSnapshotTexts() };
    },
  },
  {
    thread: "A failed save strands a switch",
    model: SARVAM,
    async run(rig) {
      const socket = await signalsActive(rig);
      let failures = 1;
      rig.saves.before = async () => {
        if (failures <= 0) return;
        failures -= 1;
        throw new Error("Snapshot write failed (injected).");
      };
      const before = rig.providerRequestCount();
      const sentBefore = audioMessages(socket);
      const switching = rig.switchTo("ta").catch(() => undefined);
      await settle();
      await rig.speak(grace);
      const oldProviderAudio = audioMessages(socket) - sentBefore;
      await vi.advanceTimersByTimeAsync(10_000);
      await switching;
      rig.saves.before = undefined;
      return {
        shown: [],
        opened: rig.providerRequestCount() - before,
        status: rig.room.session?.status,
        oldProviderAudio,
      };
    },
  },
  {
    thread: "Restarts erase words viewers saw",
    model: OPENAI,
    async run(rig) {
      const [socket] = rig.providerSockets();
      await rig.speak(ada);
      await rig.commit(ada);
      socket.emit(openAiCommitted("a"));
      socket.emit(openAiDelta("a", "First "));
      socket.emit(openAiDelta("a", "then second"));
      await settle();
      return { shown: [], restarted: await rig.restartedTexts() };
    },
  },
  {
    thread: "Restarts lose speech silently",
    model: OPENAI,
    async run(rig) {
      await rig.speak(ada);
      await rig.speak(ada);
      await settle();
      return { shown: [], restarted: await rig.restartedTexts() };
    },
  },
  {
    thread: "Ended lines pile up",
    model: OPENAI,
    env: { TRANSCRIPT_MAX_SEGMENTS: "40" },
    async run(rig) {
      const [socket] = rig.providerSockets();
      for (let index = 0; index < 120; index += 1) {
        await rig.sendAudio("silence", ada);
        await rig.commit(ada);
        socket.emit(openAiCommitted(`s${index}`));
        socket.emit({
          type: "conversation.item.input_audio_transcription.failed",
          item_id: `s${index}`,
          error: { message: "No speech." },
        });
        await settle();
      }
      const internals = rig.room as unknown as {
        ledger: { size: number };
        liveConnection: { providerToLine: Map<string, string> } | null;
      };
      return {
        shown: [],
        retained: {
          linesWithinCap: internals.ledger.size <= 40,
          mappingsWithinCap: (internals.liveConnection?.providerToLine.size ?? 0) <= 40,
          lines: Math.min(internals.ledger.size, 41),
        },
      };
    },
  },
  {
    thread: "Later audio gets dropped first",
    model: OPENAI,
    async run(rig) {
      const [socket] = rig.providerSockets();
      const owedChunks = Math.floor((0.95 * REPLAY_AUDIO_LIMIT) / LONG_SPEECH.length);
      for (let index = 0; index < owedChunks; index += 1) {
        await rig.send({ type: "audio.chunk", audio: LONG_SPEECH, speaker: ada });
      }
      await rig.commit(ada);
      socket.emit(openAiCommitted("a"));
      rig.connectPlans.push(...Array<"unreachable">(30).fill("unreachable"));
      socket.disconnect();
      await settle();
      const newChunks = Math.ceil((0.3 * REPLAY_AUDIO_LIMIT) / LONG_SPEECH.length);
      for (let index = 0; index < newChunks; index += 1) {
        await rig.send({ type: "audio.chunk", audio: LONG_SPEECH, speaker: grace });
      }
      return { shown: [], bufferedBytes: Math.min(bufferedBytes(rig), newChunks * LONG_SPEECH.length) };
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
    shown: [["Setup.", "grace"], ["Ada one.", "ada"], ["Grace words.", "grace"]],
    replayedChunks: 1,
  },
  "Delayed signals hide speech": { shown: [["Setup.", "grace"], [GAP, "ada"], [GAP, "ada"]] },
  "Empty answers leave false gaps": { shown: [] },
  "Same-tick speech disappears": { shown: [["Setup.", "grace"], [GAP, "ada"]] },
  "Resolving speech hides another speaker": {
    shown: [["Setup.", "grace"], ["Ada words.", "ada"], [GAP, "grace"]],
  },
  "Delayed claims steal later audio": {
    shown: [["Setup.", "grace"], ["Ada one.", "ada"], ["Grace words.", "grace"]],
    replayedChunks: 1,
  },
  "Late signals miss ongoing speech": { shown: [["Setup.", "grace"], [GAP, "ada"]] },
  "Brief drops end recoverable captions": { shown: [["Recovered.", "ada"]], replayedChunks: 1 },
  "Short turns lose replay audio": { shown: [["Setup.", "grace"], ["Ada short.", "ada"]], replayedChunks: 1 },
  "Shown words are not saved": { shown: [], saved: ["Hello there"] },
  "Early starts miss continuing speech": {
    shown: [["Setup.", "grace"], ["Short.", "ada"], ["Continued.", "ada"]],
    replayedChunks: 3,
  },
  "Switches can lose buffered speech": { shown: [], replayedChunks: 3, supersededChunks: 0 },
  "Corrupt audio escapes error checks": { shown: [["Setup.", "grace"], ["Still heard.", "ada"]], threw: false },
  "Restored pauses leak audio": { shown: [], forwarded: 0, status: "paused" },
  "Late answers take the next caption": {
    shown: [["Setup.", "grace"], [GAP, "ada"], ["Grace words.", "grace"]],
  },
  "Repeated answers take the next caption": {
    shown: [["Setup.", "grace"], ["Ada words.", "ada"], ["Grace words.", "grace"]],
  },
  "Replays land after later finals": {
    shown: [["Setup.", "grace"], ["Ada words.", "ada"], ["Grace words.", "grace"]],
    saved: ["Setup.", "Ada words.", "Grace words."],
  },
  "A failed save strands a switch": { shown: [], opened: 1, status: "live", oldProviderAudio: 1 },
  "Restarts erase words viewers saw": { shown: [], restarted: ["First then second"] },
  "Restarts lose speech silently": { shown: [], restarted: [GAP] },
  "Ended lines pile up": { shown: [], retained: { linesWithinCap: true, mappingsWithinCap: true, lines: 40 } },
  "Later audio gets dropped first": {
    shown: [],
    bufferedBytes: Math.ceil((0.3 * REPLAY_AUDIO_LIMIT) / LONG_SPEECH.length) * LONG_SPEECH.length,
  },
  "Recent speech loses its speaker": { shown: [["Setup.", "grace"], ["Ada long.", "ada"]], replayedChunks: 27 },
  "Same-tick audio changes owners": {
    shown: [["Setup.", "grace"], ["One.", "ada"], ["Two.", "grace"]],
    replayedChunks: 3,
  },
  "Replays change speaking order": {
    shown: [["Setup.", "grace"], ["Ada first.", "ada"], ["Grace second.", "grace"], ["Ada third.", "ada"]],
    replayedChunks: 3,
  },
};

describe("the caption model: what each signal claims, what is shown and what is replayed", () => {
  it.each(cases.map((testCase) => [testCase.thread, testCase] as const))("%s", async (_, testCase) => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rig = await transcriptRoomRig(lookup, testCase.model, testCase.env);
    await rig.start(testCase.model === OPENAI ? "en" : "hi");
    expect(await testCase.run(rig)).toEqual(expected[testCase.thread]);
  });
});

type PlacedLine = { id: string; place: { sequence: number; startMs: number }; speaker: { userId: string } };
const ledgerOf = (rig: Rig) =>
  (rig.room as unknown as { ledger: { activeUnordered(): PlacedLine[] } }).ledger;
const segmentOf = (rig: Rig, text: string) =>
  (rig.room as unknown as { segments: { text: string; sequence: number; startMs: number; speakerUserId?: string }[] })
    .segments.find((segment) => segment.text === text);
const startRig = async (model: string) => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const rig = await transcriptRoomRig(lookup, model);
  await rig.start(model === OPENAI ? "en" : "hi");
  return rig;
};

describe("a line's place and start come from its first audio and never move (Greptile at 52d2f420)", () => {
  it("a long Sarvam caption keeps its first audio's place and start when the audio limit trims its oldest chunks", async () => {
    const rig = await startRig(SARVAM);
    await signalsActive(rig);
    await rig.send({ type: "audio.chunk", audio: LONG_SPEECH, speaker: ada });
    const socket = await rig.lane(ada);
    socket.emit(sarvamSpeechStart());
    await settle();
    const line = ledgerOf(rig).activeUnordered().find(({ speaker }) => speaker.userId === "ada")!;
    const first = { ...line.place };
    const chunks = Math.ceil((1.5 * REPLAY_AUDIO_LIMIT) / LONG_SPEECH.length);
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      await vi.advanceTimersByTimeAsync(20);
      await rig.send({ type: "audio.chunk", audio: LONG_SPEECH, speaker: ada });
    }
    expect(line.place).toEqual(first);

    socket.emit(sarvamFinal("ada", "Ada long."));
    await settle();
    const segment = segmentOf(rig, "Ada long.")!;
    expect([segment.sequence, segment.startMs]).toEqual([first.sequence, first.startMs]);
  });

  it("a caption from audio buffered during a slow reconnect starts when its speech reached the room", async () => {
    const rig = await startRig(SARVAM);
    const socket = await signalsActive(rig);
    rig.connectPlans.push({ lateMs: 5_000 });
    socket.disconnect();
    await settle();
    const reachedRoomAt = Date.now();
    await rig.speak(ada);
    await vi.advanceTimersByTimeAsync(7_000);
    const replacement = rig.providerSockets().at(-1)!;
    expect(replacement).not.toBe(socket);
    replacement.emit(sarvamSpeechStart());
    await rig.endTurn(ada);
    replacement.emit(sarvamFinal("ada", "Ada buffered."));
    await settle();

    expect(segmentOf(rig, "Ada buffered.")?.startMs).toBe(reachedRoomAt);
  });
});
