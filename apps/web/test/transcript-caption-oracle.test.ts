import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptSegment } from "@conclave/meeting-core/transcript-types";
import { QUEUED_MARKER_BYTES } from "../transcript-worker/src/audio-store";
import {
  SARVAM_HUM_MS,
  SARVAM_MAX_LANES,
  SARVAM_WINDOW_QUIET_MS,
  TRANSCRIPTION_GAP_MARKER as GAP,
  TRANSCRIPTION_LINE_DEADLINE_MS as DEADLINE,
} from "../transcript-worker/src/constants";
import { Pcm24To16Downsampler } from "../transcript-worker/src/transcription/sarvam";
import { VOICE_HANGOVER_MS, VoiceActivity } from "../transcript-worker/src/transcription/voice-activity";
import { orderTranscriptSegments } from "../src/app/lib/transcript-reducer";
import { clicksPcm, noisePcm, pcmBase64, silencePcm, voicedPcm } from "./transcript-audio-fixtures";
import { FakeProviderSocket, OPENAI, SARVAM, transcriptRoomRig } from "./transcript-room-rig";

const { lookup, limit } = vi.hoisted(() => ({ lookup: vi.fn(), limit: { bytes: 0, real: 0 } }));
vi.mock("../transcript-worker/src/constants", async (original) => {
  const actual = await original<typeof import("../transcript-worker/src/constants")>();
  limit.real = actual.TRANSCRIPTION_RECOVERY_MAX_AUDIO_BYTES;
  limit.bytes = limit.real;
  return {
    ...actual,
    get TRANSCRIPTION_RECOVERY_MAX_AUDIO_BYTES() {
      return limit.bytes;
    },
  };
});
vi.mock("@conclave/ai/room-server", async (original) => ({
  ...(await original<typeof import("@conclave/ai/room-server")>()),
  fetchRoomAiEnvironment: lookup,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  limit.bytes = limit.real;
});

const RUNS = Number(process.env.TRANSCRIPT_ORACLE_RUNS ?? 300);
const FIRST = Number(process.env.TRANSCRIPT_ORACLE_FROM ?? 1);
const MAX_FAILURES = Number(process.env.TRANSCRIPT_ORACLE_MAX_FAILURES ?? 3);
const STEPS = 36;
const POOL = 240;
const BURST_LIMIT_CHUNKS = 24;
const LOOKBACK_MS = 1_500;
const VAD_PAUSE_MS = 500;
const RELAY_TURN_END_MS = 1_200;
const HELD_AUDIO_WAIT_LIMIT_MS = 12_000;
const QUIET_TURN_END_MS = 3_500;
const SAVE_FAILURE = "Snapshot write failed (injected).";
const LANGUAGES = ["ta", "hi", "bn"];
const MALFORMED = ["%%%%", "@@@@AAAA", "A", "====", "AB=C", "\u0000\u0001"];
const realSetImmediate = globalThis.setImmediate.bind(globalThis);
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const TRACE = process.env.TRANSCRIPT_ORACLE_TRACE;
const traceLines: string[] = [];
const trace = (line: string) => {
  if (TRACE) traceLines.push(`${Date.now() % 1_000_000} ${line}`);
};

type Kind = "speech" | "soft" | "whisper" | "noise" | "clicks" | "silence";
const KINDS: readonly Kind[] = ["speech", "soft", "whisper", "noise", "clicks", "silence"];
const SPOKEN: ReadonlySet<Kind> = new Set(["speech", "soft", "whisper"]);

const pcmFor = (kind: Kind, index: number): Int16Array => {
  const pitch = 100 + index * 1.21;
  if (kind === "speech") return voicedPcm(-26, 200, pitch);
  if (kind === "soft") return voicedPcm(-44, 200, pitch);
  if (kind === "whisper") return voicedPcm(-56, 200, pitch);
  if (kind === "noise") return noisePcm(-60, 200, index + 1);
  if (kind === "clicks") return clicksPcm(-12, 200, index + 1);
  const samples = silencePcm();
  samples[(index * 3) % samples.length] = 1 + (index % 7);
  return samples;
};

const pools = new Map<Kind, { wire24: string[]; wire16: string[]; heard: boolean[] }>();
const poolOf = (kind: Kind) => {
  let pool = pools.get(kind);
  if (!pool) {
    const pcm = Array.from({ length: POOL }, (_, index) => pcmFor(kind, index));
    const wire24 = pcm.map(pcmBase64);
    pool = {
      wire24,
      wire16: wire24.map((audio) => new Pcm24To16Downsampler().downsample(audio)),
      heard: pcm.map((samples) => new VoiceActivity().push(samples, 0) !== "quiet"),
    };
    pools.set(kind, pool);
  }
  return pool;
};

type Speaker = { userId: string; displayName: string; source?: "screen" };
const speakers: Speaker[] = [
  { userId: "ada", displayName: "Ada" },
  { userId: "grace", displayName: "Grace" },
  { userId: "lin", displayName: "Lin" },
];
const crowd: Speaker[] = [
  ...speakers,
  { userId: "mo", displayName: "Mo" },
  { userId: "kit", displayName: "Kit" },
  { userId: "ada", displayName: "Ada", source: "screen" },
];
const keyOf = (speaker: Speaker) => `${speaker.userId}:${speaker.source ?? ""}`;

const randomFrom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

type Utterance = {
  uid: number;
  speaker: Speaker;
  kind: Kind;
  arrivals: number[];
  heard: boolean;
  accepted: boolean;
  pauseEpoch: number;
};
type Tag = { utterance: Utterance; chunk: number };
type Line = { itemId: string; text: string; speakerUserId?: string; source?: string; sequence: number; startMs: number };
const sourceOf = (line: Line) => `${line.speakerUserId}:${line.source ?? "mixed"}`;

const tokensOf = (text: string) =>
  Array.from(text.matchAll(/U(\d+)\.(\d+):([a-z]+)/g), ([, uid, chunk, speaker]) => ({
    uid: Number(uid),
    chunk: Number(chunk),
    speaker,
  }));
const tokenOf = ({ utterance, chunk }: Tag) => `U${utterance.uid}.${chunk}:${utterance.speaker.userId}`;

const suiteCounters = {
  pausesWithHeldAudio: 0,
  takeoversWhilePaused: 0,
  clearsWithoutCommit: 0,
  lateSarvamAnswers: 0,
  stalledProviders: 0,
  evictions: 0,
  failedReplays: 0,
  failedSavesBeforeStop: 0,
  restarts: 0,
  closedSocketEvents: 0,
  lateStarts: 0,
  repeatedStarts: 0,
  interleavedClears: 0,
  outageStorms: 0,
  leaves: 0,
  speakersWaitingForALane: 0,
  switchesMidTurn: 0,
  quietAnswersAfterTheirTurn: 0,
  slowSarvamAnswers: 0,
  emptyAnswers: 0,
  outOfOrderSaves: 0,
  whisperCaptions: 0,
  turnsAfterAQuietEnd: 0,
  hums: 0,
  humHeldBack: 0,
};

type Mode = { burst?: boolean; pauses?: boolean; crowd?: boolean };

const runOnce = async (seed: number, mode: Mode = {}): Promise<string[]> => {
  const random = randomFrom(seed);
  const problems: string[] = [];
  const report = (message: string) => {
    if (problems.length < 5) problems.push(message);
  };
  const openai = seed % 2 === 0;
  const sarvamSignals = random() < 0.8;
  limit.bytes = mode.burst ? poolOf("speech").wire24[0].length * BURST_LIMIT_CHUNKS : limit.real;
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});

  const tag24 = new Map<string, Tag>();
  const tag16 = new Map<string, Tag>();
  const utterances: Utterance[] = [];
  const pausedPayloads = new Set<string>();
  const startedPromptly = new Set<number>();
  const answeredLive = new Set<number>();
  const answeredOn = new Map<number, Set<number>>();
  const emptyOn = new Map<number, number>();
  const committedLive = new Set<number>();
  const used = new Map<Kind, number>(KINDS.map((kind) => [kind, 0]));
  const timeline: { at: number; speaker: string; who: string; uid: number; heard: boolean; event: number }[] = [];
  const lastHeardAt = new Map<string, number>();
  const turnEnds = new Map<string, number[]>();
  const sentAs = new Map<string, number>();
  const lastChunkAt = new Map<string, number>();
  const lastChunkEvent = new Map<string, number>();
  const reached = new Set<string>();
  const reachedAt = new Map<string, number>();
  const quietRuns = new Map<string, { first: string; lastAt: number }>();
  const quietRunOf = new Map<string, string>();
  const heldBack = new Set<string>();
  const lastCarriedOn = new Map<number, number>();
  const answeredAfterClose = new Map<number, number>();
  const sarvamSpoke = new Map<string, { at: number; epoch: number | null }[]>();
  const sentBy = new Map<string, string[]>();
  let driverEvents = 0;
  let pauseEpoch = 0;

  const fakes = new Map<FakeProviderSocket, { receive(message: Record<string, unknown>): void }>();
  const wireTurns = new Map<FakeProviderSocket, { epoch: number | null; bounded: boolean }>();
  const wireSources = new Map<FakeProviderSocket, { who: string | null; flushed: boolean }>();
  const statusOf = () => {
    const messages = rig?.sentMessages() ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const status = messages[index]?.session?.status;
      if (status) return status as string;
    }
    return "idle";
  };
  const emitAt = (
    at: number,
    socket: FakeProviderSocket,
    event: object,
    onEmit?: (open: boolean) => void,
    onClosed?: () => void,
  ) => {
    setTimeout(() => {
      const open = !socket.closed;
      if (!open) onClosed?.();
      if (!open && random() >= 0.3) return;
      if (!open) suiteCounters.closedSocketEvents += 1;
      onEmit?.(open);
      trace(`emit r${socket.requestIndex}${open ? "" : " (closed)"} ${JSON.stringify(event)}`);
      socket.emit(event);
    }, Math.max(0, at - Date.now()));
  };

  const fakeOpenAi = (socket: FakeProviderSocket) => {
    let buffer: Tag[] = [];
    let items = 0;
    let lastAckAt = 0;
    let stalled = false;
    return {
      receive(message: Record<string, unknown>) {
        if (message.type === "input_audio_buffer.append") {
          const tag = tag24.get(String(message.audio));
          if (tag) buffer.push(tag);
          return;
        }
        if (message.type === "input_audio_buffer.clear") {
          buffer = [];
          return;
        }
        if (message.type !== "input_audio_buffer.commit") return;
        const tags = buffer;
        buffer = [];
        const itemId = `item_${socket.requestIndex}_${(items += 1)}`;
        const spoken = tags.filter(({ utterance }) => SPOKEN.has(utterance.kind));
        for (const { utterance } of tags) committedLive.add(utterance.uid);
        const text = Array.from(new Set(spoken.map(tokenOf))).join(" ");
        if (stalled) return;
        const ackRoll = random();
        if (ackRoll < 0.02) {
          stalled = true;
          suiteCounters.stalledProviders += 1;
          return;
        }
        const ackAt = Math.max(lastAckAt + 1, Date.now() + (ackRoll < 0.06 ? 46_000 + random() * 6_000 : 5 + random() * 400));
        lastAckAt = ackAt;
        emitAt(ackAt, socket, { type: "input_audio_buffer.committed", item_id: itemId });
        const fate = random();
        if (fate < 0.03) {
          emitAt(ackAt + 20, socket, {
            type: "conversation.item.input_audio_transcription.failed",
            item_id: itemId,
            error: { message: "Audio could not be transcribed." },
          });
          return;
        }
        if (fate < 0.06) return;
        if (text && random() < 0.4) {
          emitAt(ackAt + 10 + random() * 300, socket, {
            type: "conversation.item.input_audio_transcription.delta",
            item_id: itemId,
            delta: text,
          });
        }
        const finalAt = ackAt + (random() < 0.05 ? 33_000 + random() * 25_000 : 400 + random() * 2_000);
        emitAt(finalAt, socket, {
          type: "conversation.item.input_audio_transcription.completed",
          item_id: itemId,
          transcript: text,
        });
      },
    };
  };

  const fakeSarvam = (socket: FakeProviderSocket) => {
    let current: {
      tags: Tag[];
      utterances: Utterance[];
      speaker: string;
      openedAt: number;
      heardAt: number;
      startAt: number;
      falseStart: boolean;
      lateStart: boolean;
    } | null = null;
    let lastAnswerAt = 0;
    let lastSignalAt = 0;
    let answers = 0;
    let stalled = false;
    const live = { starts: 0, answers: 0, speaking: false };
    const carried = new Set<string>();
    let epoch: number | null = null;
    const spoke = () => {
      for (const run of carried) sarvamSpoke.set(run, [...(sarvamSpoke.get(run) ?? []), { at: Date.now(), epoch }]);
    };
    const startSignal = (at: number, onEmit?: (open: boolean) => void) =>
      emitAt(at, socket, { type: "events", data: { signal_type: "START_SPEECH" } }, (open) => {
        if (open && !live.speaking) live.starts += 1;
        if (open) live.speaking = true;
        if (open) spoke();
        onEmit?.(open);
      });
    const endSignal = (at: number) =>
      emitAt(at, socket, { type: "events", data: { signal_type: "END_SPEECH" } }, (open) => {
        if (open) live.speaking = false;
        if (open) spoke();
      });
    const close = (atFlush = false) => {
      const closing = current;
      if (!closing) return;
      current = null;
      const now = Date.now();
      if (closing.lateStart) {
        closing.startAt = Math.max(now + (random() < 0.7 ? 500 + random() * 4_500 : 5_000 + random() * 25_000), lastSignalAt + 1);
        lastSignalAt = closing.startAt;
        suiteCounters.lateStarts += 1;
        startSignal(closing.startAt);
      }
      if (sarvamSignals && (!atFlush || random() < 0.9)) {
        lastSignalAt = Math.max(now + 20 + random() * 200, closing.startAt + 1, lastSignalAt + 1);
        endSignal(lastSignalAt);
      }
      if (stalled) return;
      const roll = random();
      if (roll < 0.025 && !closing.falseStart) {
        stalled = true;
        suiteCounters.stalledProviders += 1;
        return;
      }
      const late = roll < 0.1;
      const slow = !late && roll < 0.25;
      if (slow) suiteCounters.slowSarvamAnswers += 1;
      const at = Math.max(
        now + (late ? DEADLINE + 1_000 + random() * 34_000 : slow ? 2_500 + random() * 22_500 : 150 + random() * 2_300),
        lastAnswerAt + 1,
        closing.startAt + 2,
      );
      lastAnswerAt = at;
      const empty = !closing.falseStart && random() < 0.03;
      const transcript = closing.falseStart || empty ? "" : Array.from(new Set(closing.tags.map(tokenOf))).join(" ");
      const requestId = random() < 0.1 ? null : `r${socket.requestIndex}-${(answers += 1)}`;
      const answer = { type: "data", data: { transcript, ...(requestId ? { request_id: requestId } : {}) } };
      const afterClose = () => {
        if (live.answers < 1 || live.starts > live.answers) return;
        for (const { uid } of closing.utterances) answeredAfterClose.set(uid, socket.requestIndex);
      };
      emitAt(at, socket, answer, (open) => {
        if (open) {
          live.answers += 1;
          live.speaking = false;
          if (transcript) spoke();
        }
        if (late) suiteCounters.lateSarvamAnswers += 1;
        if (open && empty) {
          suiteCounters.emptyAnswers += 1;
          for (const { uid } of closing.utterances) emptyOn.set(uid, socket.requestIndex);
        }
        if (open && transcript) {
          for (const { uid } of closing.utterances) {
            answeredLive.add(uid);
            answeredOn.set(uid, (answeredOn.get(uid) ?? new Set()).add(socket.requestIndex));
          }
        }
        if (open && transcript && closing.lateStart && closing.utterances.some((each) => !each.heard)) {
          suiteCounters.quietAnswersAfterTheirTurn += 1;
        }
      }, afterClose);
      if (requestId && random() < 0.04) emitAt(at, socket, answer);
    };
    const open = (tag: Tag, falseStart: boolean) => {
      const now = Date.now();
      const roll = random();
      const wanted = roll < 0.75 ? random() * 300 : roll < 0.95 ? 300 + random() * 1_100 : 1_600 + random() * 800;
      const delay = sarvamSignals ? Math.max(wanted, lastSignalAt + 1 - now) : wanted;
      const lateStart = sarvamSignals && !falseStart && random() < 0.06;
      if (sarvamSignals && !lateStart) lastSignalAt = now + delay;
      const opened = {
        tags: [tag],
        utterances: [tag.utterance],
        speaker: tag.utterance.speaker.userId,
        openedAt: now,
        heardAt: now,
        startAt: now + delay,
        falseStart,
        lateStart,
      };
      current = opened;
      if (!sarvamSignals || lateStart) return;
      startSignal(now + delay, (open) => {
        if (open && delay <= LOOKBACK_MS - 100) for (const { uid } of opened.utterances) startedPromptly.add(uid);
      });
      if (random() < 0.04) {
        const again = now + delay + 200 + random() * 3_500;
        lastSignalAt = Math.max(lastSignalAt, again);
        suiteCounters.repeatedStarts += 1;
        startSignal(again);
      }
    };
    return {
      receive(message: Record<string, unknown>) {
        const data = (message.audio as { data?: unknown } | undefined)?.data;
        if (typeof data === "string" && data) {
          const tag = tag16.get(data);
          if (!tag) return;
          lastCarriedOn.set(tag.utterance.uid, socket.requestIndex);
          const run = quietRunOf.get(`${tag.utterance.uid}.${tag.chunk}`);
          if (run) carried.add(run);
          epoch ??= internals.liveConnection?.epoch ?? null;
          if (SPOKEN.has(tag.utterance.kind)) {
            const now = Date.now();
            if (current && !current.falseStart && current.speaker === tag.utterance.speaker.userId && now - current.heardAt < VAD_PAUSE_MS) {
              if (!current.utterances.includes(tag.utterance)) current.utterances.push(tag.utterance);
              current.tags.push(tag);
              current.heardAt = now;
              return;
            }
            close();
            open(tag, false);
            return;
          }
          close();
          if (tag.utterance.kind !== "silence" && random() < 0.05) {
            open(tag, true);
            close();
          }
          return;
        }
        if (message.type === "flush" || message.type === "end_of_stream") close(true);
      },
    };
  };

  const onWire = (socket: FakeProviderSocket, message: Record<string, unknown>) => {
    const status = statusOf();
    const audio =
      typeof message.audio === "string"
        ? message.audio
        : ((message.audio as { data?: string } | undefined)?.data ?? "");
    const tag = audio ? (openaiSocket(socket) ? tag24 : tag16).get(audio) : undefined;
    const carriesAudio = Boolean(audio) || message.type === "input_audio_buffer.commit";
    if (carriesAudio && status === "paused") report(`request ${socket.requestIndex} received ${String(message.type ?? "audio")} while captions were paused`);
    if (tag && pausedPayloads.has(audio)) report(`U${tag.utterance.uid} was sent while paused yet reached a provider`);
    trace(`wire r${socket.requestIndex} ${tag ? `U${tag.utterance.uid}:${tag.utterance.speaker.userId}#${tag.chunk}` : String(message.type ?? (audio ? "unknown audio" : "?"))}`);
    const turn = wireTurns.get(socket) ?? { epoch: null, bounded: true };
    if (rig) noteWhatBlocksSending();
    const quietRunOnWire = tag ? quietRunOf.get(`${tag.utterance.uid}.${tag.chunk}`) : undefined;
    if (quietRunOnWire !== undefined && !reachedAt.has(quietRunOnWire)) reachedAt.set(quietRunOnWire, Date.now());
    if (tag) reached.add(`${tag.utterance.uid}.${tag.chunk}`);
    if (tag) {
      if (turn.epoch !== null && turn.epoch !== tag.utterance.pauseEpoch && !turn.bounded) {
        report(`U${tag.utterance.uid} joined pre-pause audio in one provider turn on request ${socket.requestIndex}`);
      }
      turn.epoch = tag.utterance.pauseEpoch;
      turn.bounded = false;
    } else if (["flush", "end_of_stream", "input_audio_buffer.commit", "input_audio_buffer.clear"].includes(String(message.type))) {
      turn.bounded = true;
    }
    wireTurns.set(socket, turn);
    if (!openaiSocket(socket)) {
      const carried = wireSources.get(socket) ?? { who: null, flushed: false };
      wireSources.set(socket, carried);
      if (tag) {
        const who = keyOf(tag.utterance.speaker);
        if (carried.who !== null && carried.who !== who) {
          report(`request ${socket.requestIndex} carried audio of ${carried.who} and of ${who}`);
        }
        if (carried.flushed) report(`request ${socket.requestIndex} took U${tag.utterance.uid} after its turn had ended`);
        carried.who = who;
      } else if (message.type === "flush") {
        carried.flushed = true;
      }
    }
    let fake = fakes.get(socket);
    if (!fake) {
      fake = openaiSocket(socket) ? fakeOpenAi(socket) : fakeSarvam(socket);
      fakes.set(socket, fake);
    }
    fake.receive(message);
  };
  const openaiSocket = (socket: FakeProviderSocket) => /\/v1\/realtime/.test(socket.url);
  const openSarvamSockets = () => rig.providerSockets().filter((socket) => !socket.closed && !openaiSocket(socket)).length;
  const whoOf = (speaker: Speaker) => `${speaker.userId}:${speaker.source ?? "mixed"}`;
  let scannedForRefusals = 0;
  let refusals = 0;
  const refusedSoFar = () => {
    const messages = rig.sentMessages();
    for (; scannedForRefusals < messages.length; scannedForRefusals += 1) {
      if (messages[scannedForRefusals].type === "error") refusals += 1;
    }
    return refusals;
  };
  const endTurnOf = async (who: Speaker, stage: string, how: "clear" | "commit and clear" = "clear") => {
    const refusedBefore = refusedSoFar();
    await tolerate(() => (how === "clear" ? rig.clear(who) : rig.endTurn(who)), stage);
    if (refusedSoFar() !== refusedBefore) return;
    turnEnds.set(whoOf(who), [...(turnEnds.get(whoOf(who)) ?? []), (driverEvents += 1)]);
  };

  const rig = await transcriptRoomRig(
    lookup,
    openai ? OPENAI : SARVAM,
    { TRANSCRIPT_TOKEN_SECRET: "caption-oracle-secret" },
    { onProviderSend: (socket, message) => onWire(socket, message) },
  );
  type Store = {
    all(): readonly {
      audio: string;
      sequence: number;
      sentAt: number | null;
      speaker: { userId: string; source?: string };
      owner: { kind: string; lineId?: string };
    }[];
    queuedEvents(): readonly { type: string; speaker?: { userId: string; source?: string } }[];
    bytes: number;
    enforceBudget(bytes: number): { sequence: number }[];
  };
  type Internals = {
    audio: Store;
    ledger: { get(id: string): { state: string; epoch: number | null } | undefined };
    liveConnection: { epoch: number } | null;
  };
  const internals = rig.room as unknown as Internals;
  const enforce = internals.audio.enforceBudget.bind(internals.audio);
  internals.audio.enforceBudget = (bytes: number) => {
    const evicted = enforce(bytes);
    if (evicted.length > 0) {
      suiteCounters.evictions += evicted.length;
      const newestEvicted = Math.max(...evicted.map(({ sequence }) => sequence));
      const oldestKept = internals.audio.all()[0]?.sequence;
      if (oldestKept !== undefined && oldestKept < newestEvicted) {
        report(`the audio limit dropped #${newestEvicted} but kept older #${oldestKept}`);
      }
    }
    return evicted;
  };

  const saveMode = { delayMs: 0, fail: false, failOnce: false, jitter: false };
  let savesInFlight = 0;
  let lastSaveFailed = false;
  {
    const storage = (rig.room as unknown as {
      state: { storage: { put: (key: string, value: unknown) => Promise<void>; delete: (key: string) => Promise<boolean> } };
    }).state.storage;
    const put = storage.put.bind(storage);
    const remove = storage.delete.bind(storage);
    let called = 0;
    let settledUpTo = 0;
    const settleAfter = (delayMs: number) => {
      const wait = delayMs > 0 ? delayMs * (0.5 + random()) : saveMode.jitter && random() < 0.3 ? random() * 40 : 0;
      return wait > 0 ? new Promise((resolve) => setTimeout(resolve, wait)) : Promise.resolve();
    };
    const track = (order: number) => {
      if (order < settledUpTo) suiteCounters.outOfOrderSaves += 1;
      settledUpTo = Math.max(settledUpTo, order);
    };
    storage.delete = (key) => {
      const order = (called += 1);
      const done = remove(key);
      return settleAfter(saveMode.delayMs).then(() => {
        track(order);
        return done;
      });
    };
    storage.put = (key, value) => {
      const order = (called += 1);
      const fail = saveMode.fail || saveMode.failOnce;
      saveMode.failOnce = false;
      savesInFlight += 1;
      lastSaveFailed = fail;
      const stored = fail ? null : put(key, structuredClone(value));
      return settleAfter(saveMode.delayMs).then(async () => {
        try {
          track(order);
          if (fail) throw new Error(SAVE_FAILURE);
          await stored;
        } finally {
          savesInFlight -= 1;
        }
      });
    };
  }

  const tolerate = async (action: () => Promise<unknown>, stage: string) => {
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== SAVE_FAILURE) report(`${stage}: handler threw ${message}`);
    }
  };

  const firstSeen = new Map<string, string>();
  let checkedMessages = 0;
  const checkStability = (stage: string) => {
    const messages = rig.sentMessages();
    for (; checkedMessages < messages.length; checkedMessages += 1) {
      const message = messages[checkedMessages];
      const lines: Line[] =
        message.type === "segment.delta"
          ? [{ ...message.delta, speakerUserId: message.delta.speaker.userId }]
          : message.type === "segment.final"
            ? [message.segment]
            : message.type === "snapshot"
              ? [...(message.segments ?? []), ...(message.partials ?? [])]
              : [];
      for (const line of lines) {
        const shape = JSON.stringify([line.sequence, line.startMs, line.speakerUserId]);
        const before = firstSeen.get(line.itemId);
        if (before !== undefined && before !== shape) {
          report(`${stage}: ${line.itemId} moved from ${before} to ${shape} after viewers saw it`);
        }
        firstSeen.set(line.itemId, before ?? shape);
      }
    }
  };

  const viewerLines = (): Line[] => {
    const viewer = rig.viewerTranscript();
    return orderTranscriptSegments([...viewer.segments, ...viewer.partials.values()] as TranscriptSegment[]);
  };

  const checkSpeakers = (stage: string, lines: Line[], where: string) => {
    for (const line of lines) {
      for (const token of tokensOf(line.text)) {
        if (token.speaker !== line.speakerUserId) {
          report(`${stage}: ${where} shows U${token.uid} (${token.speaker}) under ${line.speakerUserId}`);
        }
      }
    }
  };

  const checkOrder = (stage: string, lines: Line[], where: string) => {
    let previous = -1;
    for (const line of lines) {
      const tokens = tokensOf(line.text);
      tokens.forEach(({ uid }, at) => {
        if (at > 0 && uid < tokens[at - 1].uid) report(`${stage}: ${where} shows U${uid} after U${tokens[at - 1].uid} in one line`);
      });
      if (!openai) continue;
      for (const { uid } of tokens) {
        if (uid < previous) report(`${stage}: ${where} shows U${uid} after U${previous}`);
        previous = Math.max(previous, uid);
      }
    }
  };

  const checkChunksOnce = (stage: string, lines: Line[]) => {
    const shownIn = new Map<string, string>();
    for (const line of lines) {
      for (const { uid, chunk } of tokensOf(line.text)) {
        const key = `U${uid}.${chunk}`;
        const before = shownIn.get(key);
        if (before !== undefined && before !== line.itemId) report(`${stage}: ${key} is shown in two lines`);
        shownIn.set(key, line.itemId);
      }
    }
  };

  const runsFrom = (line: Line) =>
    timeline.flatMap(({ at, who }, start) => {
      if (at !== line.startMs || who !== sourceOf(line)) return [];
      let end = start;
      while (end + 1 < timeline.length && timeline[end + 1].who === sourceOf(line)) end += 1;
      return [timeline.slice(start, end + 1)];
    });
  const runFrom = (line: Line) => runsFrom(line).flat();

  const checkStarts = (stage: string, lines: Line[]) => {
    if (!openai) return;
    for (const line of lines) {
      const [first] = tokensOf(line.text);
      if (!first) continue;
      if (!runFrom(line)?.some(({ uid }) => uid === first.uid)) {
        report(`${stage}: the line showing U${first.uid} starts at ${line.startMs}, not in its speaker's audio just before it`);
      }
    }
  };

  const checkTurns = (stage: string, lines: Line[]) => {
    for (const line of lines) {
      const sent = tokensOf(line.text)
        .map(({ uid, chunk }) => sentAs.get(`${uid}.${chunk}`))
        .filter((event): event is number => event !== undefined);
      if (sent.length === 0) continue;
      const first = Math.min(...sent);
      const last = Math.max(...sent);
      const ends = turnEnds.get(sourceOf(line)) ?? [];
      const crossesATurnEnd = (from: number, to: number) => ends.some((end) => end > from && end < to);
      if (crossesATurnEnd(first, last)) {
        report(`${stage}: one line under ${line.speakerUserId} joins speech from before and after that speaker's turn ended`);
      }
      if (openai) continue;
      const starts = timeline.filter(({ at, who }) => at === line.startMs && who === sourceOf(line));
      if (starts.length > 0 && starts.every(({ event }) => crossesATurnEnd(Math.min(event, first), Math.max(event, last)))) {
        report(`${stage}: the line showing U${tokensOf(line.text)[0].uid} starts in another turn of ${line.speakerUserId} than the speech it shows`);
      }
    }
  };

  const waitingSince = new Map<number, number>();
  let blockedAt = 0;
  const noteWhatBlocksSending = () => {
    const couldSend =
      statusOf() === "live" &&
      internals.liveConnection !== null &&
      rig.openingProviderSockets() === 0 &&
      (openai || openSarvamSockets() < SARVAM_MAX_LANES);
    if (!couldSend) blockedAt = Date.now();
    return couldSend;
  };
  const checkHeldAudio = (stage: string) => {
    if (!noteWhatBlocksSending()) {
      waitingSince.clear();
      return;
    }
    const now = Date.now();
    const freeSince = Math.max(blockedAt, rig.lastOpeningSettledAt());
    const queued = new Set(internals.audio.all().filter(({ owner }) => owner.kind === "queued").map(({ sequence }) => sequence));
    for (const sequence of Array.from(waitingSince.keys())) if (!queued.has(sequence)) waitingSince.delete(sequence);
    for (const sequence of queued) {
      const since = Math.max(waitingSince.get(sequence) ?? now, freeSince);
      waitingSince.set(sequence, since);
      if (now - since > HELD_AUDIO_WAIT_LIMIT_MS) {
        report(`${stage}: audio #${sequence} waited ${now - since} ms in the room while a connection could take it`);
        waitingSince.delete(sequence);
      }
    }
  };

  const checkHeldBack = (stage: string) => {
    for (const chunk of internals.audio.all()) {
      const tag = chunk.sentAt === null ? undefined : tag24.get(chunk.audio);
      if (!tag) continue;
      const key = `${tag.utterance.uid}.${tag.chunk}`;
      if (reached.has(key) || heldBack.has(key)) continue;
      heldBack.add(key);
      const decidedAt = chunk.sentAt ?? Date.now();
      const run = quietRunOf.get(key);
      const quiet = decidedAt - (run === undefined ? decidedAt : (reachedAt.get(run) ?? decidedAt));
      const order = sentBy.get(whoOf(tag.utterance.speaker)) ?? [];
      const before = order[order.indexOf(key) - 1];
      const firstHeldBack = before === undefined || reached.has(before);
      const heardInThisAudio = (run === undefined ? [] : (sarvamSpoke.get(run) ?? [])).find(
        ({ at, epoch }) => epoch === (internals.liveConnection?.epoch ?? null) && at > decidedAt - SARVAM_HUM_MS && at <= decidedAt,
      )?.at;
      if (openai || quiet < SARVAM_HUM_MS) {
        report(`${stage}: the room held U${key} back from its provider after only ${quiet} ms of quiet audio`);
      } else if (firstHeldBack && heardInThisAudio !== undefined) {
        report(`${stage}: the room held U${key} back as hum ${decidedAt - heardInThisAudio} ms after Sarvam heard speech in that audio`);
      } else {
        suiteCounters.humHeldBack += 1;
      }
    }
  };

  const checkStore = (stage: string) => {
    const store = internals.audio;
    const chunks = store.all();
    const markers = store.queuedEvents().filter(({ type }) => type !== "chunk").length;
    const total = chunks.reduce((sum, { audio }) => sum + audio.length, 0) + markers * QUEUED_MARKER_BYTES;
    if (total !== store.bytes) report(`${stage}: the store counts ${store.bytes} bytes but holds ${total}`);
    if (total > limit.bytes) report(`${stage}: the room holds ${total} bytes of audio, over the ${limit.bytes} limit`);
    const held = new Map<string, { chunks: number; boundaries: number }>();
    const heldBy = (speaker: { userId: string; source?: string }) => {
      const key = `${speaker.userId}:${speaker.source}`;
      const entry = held.get(key) ?? { chunks: 0, boundaries: 0 };
      held.set(key, entry);
      return entry;
    };
    for (const chunk of chunks) if (chunk.owner.kind === "queued") heldBy(chunk.speaker).chunks += 1;
    for (const event of store.queuedEvents()) if (event.type !== "chunk" && event.speaker) heldBy(event.speaker).boundaries += 1;
    const queuedChunks = chunks.filter(({ owner }) => owner.kind === "queued").length;
    for (const [key, { boundaries }] of held) {
      if (boundaries > queuedChunks + 1) report(`${stage}: ${key} has ${boundaries} turn boundaries held around ${queuedChunks} queued chunks`);
    }
    const sarvamSockets = openai ? 0 : openSarvamSockets() + rig.openingProviderSockets();
    if (sarvamSockets > SARVAM_MAX_LANES) {
      report(`${stage}: the room holds ${sarvamSockets} Sarvam sockets, open or opening, over the cap of ${SARVAM_MAX_LANES}`);
    }
    if (sarvamSockets === SARVAM_MAX_LANES && queuedChunks > 0) suiteCounters.speakersWaitingForALane += 1;
    const live = internals.liveConnection?.epoch ?? null;
    for (const chunk of chunks) {
      if (chunk.owner.kind === "queued" && chunk.sentAt !== null) report(`${stage}: a queued chunk was already sent`);
      if (chunk.owner.kind === "unowned" && chunk.sentAt === null) report(`${stage}: an unowned chunk was never sent`);
      if (chunk.owner.kind !== "line") continue;
      const line = internals.ledger.get(chunk.owner.lineId ?? "");
      const active = line && ["pending_ack", "open", "replaying"].includes(line.state);
      if (!active) report(`${stage}: a ${line?.state ?? "forgotten"} line still holds audio`);
      else if (line.epoch !== null && line.epoch !== live) report(`${stage}: a line on a replaced connection still holds audio`);
    }
  };

  let tracedMessages = 0;
  const check = (stage: string) => {
    if (TRACE) {
      const messages = rig.sentMessages();
      for (; tracedMessages < messages.length; tracedMessages += 1) {
        const message = messages[tracedMessages];
        const line = message.type === "segment.final" ? message.segment : message.type === "segment.delta" ? message.delta : null;
        if (line) trace(`viewer ${message.type} ${line.itemId.slice(0, 8)} ${line.speakerUserId ?? line.speaker?.userId} seq=${line.sequence} "${line.text}"`);
        else if (message.session?.status) trace(`viewer status ${message.session.status}`);
      }
    }
    checkStability(stage);
    const lines = viewerLines();
    checkSpeakers(stage, lines, "viewers");
    checkOrder(stage, lines.filter(({ text }) => text !== GAP), "viewers");
    checkStarts(stage, lines);
    checkTurns(stage, lines);
    checkStore(stage);
    checkHeldAudio(stage);
    checkHeldBack(stage);
  };

  const describeLine = ({ itemId, text, speakerUserId, sequence, startMs }: Line) =>
    JSON.stringify([itemId, text, speakerUserId, sequence, startMs]);
  const checkJoinedViewer = async (stage: string) => {
    const fresh = await rig.viewerSnapshot();
    const joined = orderTranscriptSegments([...(fresh?.segments ?? []), ...(fresh?.partials ?? [])]).map(describeLine);
    const watching = viewerLines().map(describeLine);
    if (joined.join() !== watching.join()) report(`${stage}: a viewer joining now sees different lines than viewers who watched`);
  };

  const sendChunk = async (utterance: Utterance) => {
    const index = used.get(utterance.kind)!;
    if (index >= POOL) return false;
    used.set(utterance.kind, index + 1);
    const pool = poolOf(utterance.kind);
    const tag = { utterance, chunk: utterance.arrivals.length };
    tag24.set(pool.wire24[index], tag);
    tag16.set(pool.wire16[index], tag);
    const status = statusOf();
    if (status !== "live" && status !== "starting") {
      utterance.accepted = false;
      if (status === "paused") pausedPayloads.add(pool.wire24[index]);
    }
    utterance.arrivals.push(Date.now());
    sentAs.set(`${utterance.uid}.${tag.chunk}`, (driverEvents += 1));
    const who = whoOf(utterance.speaker);
    const before = lastChunkAt.get(who);
    if (before !== undefined && Date.now() - before > QUIET_TURN_END_MS && (turnEnds.get(who)?.at(-1) ?? 0) < (lastChunkEvent.get(who) ?? 0)) {
      suiteCounters.turnsAfterAQuietEnd += 1;
    }
    lastChunkAt.set(who, Date.now());
    lastChunkEvent.set(who, driverEvents);
    const chunkKey = `${utterance.uid}.${tag.chunk}`;
    if (!pool.heard[index]) {
      const quietRun = quietRuns.get(who);
      if (!quietRun || Date.now() - quietRun.lastAt > SARVAM_WINDOW_QUIET_MS) quietRuns.set(who, { first: chunkKey, lastAt: Date.now() });
      else quietRun.lastAt = Date.now();
      quietRunOf.set(chunkKey, quietRuns.get(who)!.first);
    }
    sentBy.set(who, [...(sentBy.get(who) ?? []), chunkKey]);
    if (pool.heard[index]) utterance.heard = true;
    trace(`send U${utterance.uid}:${utterance.speaker.userId} ${utterance.kind}#${tag.chunk} status=${status}`);
    const heardBefore = lastHeardAt.get(keyOf(utterance.speaker));
    const audible = pool.heard[index] || (heardBefore !== undefined && Date.now() - heardBefore <= VOICE_HANGOVER_MS);
    if (pool.heard[index]) lastHeardAt.set(keyOf(utterance.speaker), Date.now());
    if (status === "live" || status === "starting") {
      timeline.push({ at: Date.now(), speaker: utterance.speaker.userId, who, uid: utterance.uid, heard: audible, event: driverEvents });
    }
    await tolerate(
      () => rig.send({ type: "audio.chunk", audio: pool.wire24[index], speaker: utterance.speaker }),
      `U${utterance.uid}`,
    );
    if (pool.heard[index] && reached.has(chunkKey)) quietRuns.delete(who);
    return true;
  };

  const pool = mode.crowd ? crowd : speakers;
  let active = [...pool];
  let speaker = pool[0];
  let paused = false;
  const switches: Promise<unknown>[] = [];

  const turnOpen = new Map<string, number>();
  const speakUtterance = async (step: number) => {
    const previous = speaker;
    if (random() < 0.35 || !active.includes(speaker)) speaker = active[Math.floor(random() * active.length)];
    for (const other of pool) {
      const lastAt = turnOpen.get(keyOf(other));
      if (other === speaker || lastAt === undefined || Date.now() - lastAt < RELAY_TURN_END_MS) continue;
      turnOpen.delete(keyOf(other));
      await endTurnOf(other, `step ${step} relay turn end for ${other.userId}`);
    }
    if (previous !== speaker) trace(`driver speaker ${speaker.userId}`);
    const kindRoll = random();
    const kind: Kind =
      kindRoll < 0.55 ? "speech" : kindRoll < 0.65 ? "soft" : kindRoll < 0.72 ? "whisper" : kindRoll < 0.82 ? "noise" : kindRoll < 0.89 ? "clicks" : "silence";
    const utterance: Utterance = { uid: utterances.length, speaker, kind, arrivals: [], heard: false, accepted: true, pauseEpoch };
    utterances.push(utterance);
    const long = random() < 0.06;
    const count = mode.burst ? 4 + Math.floor(random() * BURST_LIMIT_CHUNKS) : long ? 10 + Math.floor(random() * 14) : 1 + Math.floor(random() * 3);
    for (let chunk = 0; chunk < count; chunk += 1) {
      if (!(await sendChunk(utterance))) break;
      if (chunk + 1 < count && random() < 0.08) {
        const other = pool[Math.floor(random() * pool.length)];
        if (other !== speaker) {
          suiteCounters.interleavedClears += 1;
          trace(`driver clear ${keyOf(other)} inside U${utterance.uid}`);
          await endTurnOf(other, `step ${step} interleaved clear`);
        }
      }
      if (chunk + 1 < count && random() < 0.03) {
        suiteCounters.switchesMidTurn += 1;
        const language = LANGUAGES[Math.floor(random() * LANGUAGES.length)];
        trace(`driver switch ${language} inside U${utterance.uid}`);
        if (paused) suiteCounters.takeoversWhilePaused += 1;
        switches.push(tolerate(() => rig.switchTo(language), `step ${step} switch inside a turn`));
        paused = false;
      }
      const gap = random();
      await vi.advanceTimersByTimeAsync(mode.burst ? 0 : gap < 0.4 ? 0 : gap < 0.8 ? 20 : 120 + Math.floor(random() * 330));
      check(`step ${step} U${utterance.uid} chunk ${chunk}`);
    }
    const end = random();
    trace(`driver end ${end < 0.55 ? "turn" : end < 0.65 ? "clear" : end < 0.7 ? "commit" : "none"}`);
    if (end < 0.55) {
      turnOpen.delete(keyOf(speaker));
      await endTurnOf(speaker, `step ${step} turn end`, "commit and clear");
    } else if (end < 0.65) {
      suiteCounters.clearsWithoutCommit += 1;
      turnOpen.delete(keyOf(speaker));
      await endTurnOf(speaker, `step ${step} clear`);
    } else {
      turnOpen.set(keyOf(speaker), Date.now());
      if (end < 0.7) await tolerate(() => rig.commit(speaker), `step ${step} commit`);
    }
    await vi.advanceTimersByTimeAsync(Math.floor(random() * 800));
  };

  const hum = async (step: number) => {
    const who = active[Math.floor(random() * active.length)];
    const kindRoll = random();
    const kind: Kind = kindRoll < 0.4 ? "whisper" : kindRoll < 0.7 ? "noise" : "silence";
    const utterance: Utterance = { uid: utterances.length, speaker: who, kind, arrivals: [], heard: false, accepted: true, pauseEpoch };
    utterances.push(utterance);
    suiteCounters.hums += 1;
    trace(`driver hum ${who.userId} ${kind}`);
    const count = 45 + Math.floor(random() * 30);
    for (let chunk = 0; chunk < count; chunk += 1) {
      if (!(await sendChunk(utterance))) break;
      await vi.advanceTimersByTimeAsync(180 + Math.floor(random() * 120));
      if (chunk % 10 === 9) check(`step ${step} hum ${chunk}`);
    }
    turnOpen.set(keyOf(who), Date.now());
  };

  const togglePause = async (step: number) => {
    const wanted = !paused;
    trace(wanted ? "driver pause" : "driver resume");
    if (wanted && (internals.liveConnection === null || internals.audio.all().some(({ owner }) => owner.kind === "queued"))) {
      suiteCounters.pausesWithHeldAudio += 1;
    }
    let answered = false;
    void tolerate(() => rig.send({ type: wanted ? "session.pause" : "session.resume" }), `step ${step} pause`).then(() => {
      answered = true;
    });
    for (let round = 0; round < 20 && !answered; round += 1) await vi.advanceTimersByTimeAsync(250);
    paused = statusOf() === "paused";
    if (paused && wanted) pauseEpoch += 1;
    if (!paused && !wanted) pauseEpoch += 1;
  };

  const leave = async (step: number) => {
    if (active.length < 2) return;
    const leaving = active[Math.floor(random() * active.length)];
    trace(`driver leave ${keyOf(leaving)}`);
    suiteCounters.leaves += 1;
    active = active.filter((each) => each !== leaving);
    turnOpen.delete(keyOf(leaving));
    await endTurnOf(leaving, `step ${step} leave`);
  };

  const outageStorm = async (step: number) => {
    const open = rig.providerSockets().filter(({ closed }) => !closed);
    if (open.length === 0) return;
    suiteCounters.outageStorms += 1;
    rig.connectPlans.push({ lateMs: 10_000 + Math.floor(random() * 25_000) });
    trace("driver outage storm");
    open[Math.floor(random() * open.length)].disconnect();
    const messages = 20 + Math.floor(random() * 60);
    for (let index = 0; index < messages; index += 1) {
      const who = pool[Math.floor(random() * pool.length)];
      if (random() < 0.5) await tolerate(() => rig.commit(who), `step ${step} storm`);
      else await endTurnOf(who, `step ${step} storm`);
      if (random() < 0.1) {
        const utterance: Utterance = { uid: utterances.length, speaker: who, kind: "speech", arrivals: [], heard: false, accepted: true, pauseEpoch };
        utterances.push(utterance);
        await sendChunk(utterance);
      }
      await vi.advanceTimersByTimeAsync(100);
      if (index % 10 === 9) check(`step ${step} storm ${index}`);
    }
  };

  const dropProvider = () => {
    const plan = random();
    trace(`driver drop plan=${plan.toFixed(2)}`);
    if (plan < 0.2) rig.connectPlans.push("unreachable");
    if (plan < 0.35) rig.connectPlans.push({ lateMs: 200 + Math.floor(random() * 4_000) });
    else if (plan < 0.5) {
      suiteCounters.failedReplays += 1;
      rig.connectPlans.push(1 + Math.floor(random() * 3));
    }
    const open = rig.providerSockets().filter(({ closed }) => !closed);
    open[Math.floor(random() * open.length)]?.disconnect();
  };

  await rig.start(openai ? "en" : "hi");
  saveMode.jitter = true;

  for (let step = 0; step < STEPS; step += 1) {
    const roll = random();
    const pauseChance = mode.pauses ? 0.12 : 0.05;
    if (roll < pauseChance) {
      await togglePause(step);
    } else if (roll < pauseChance + 0.08) {
      dropProvider();
      await vi.advanceTimersByTimeAsync(Math.floor(random() * 3_000));
    } else if (roll < pauseChance + 0.14) {
      if (paused) suiteCounters.takeoversWhilePaused += 1;
      if (random() < 0.4) rig.connectPlans.push({ lateMs: 200 + Math.floor(random() * 4_000) });
      const language = LANGUAGES[Math.floor(random() * LANGUAGES.length)];
      trace(`driver switch ${language}`);
      switches.push(tolerate(() => rig.switchTo(language), `step ${step} switch`));
      paused = false;
      await vi.advanceTimersByTimeAsync(Math.floor(random() * 300));
    } else if (roll < pauseChance + 0.18) {
      saveMode.delayMs = random() < 0.5 ? 0 : Math.floor(random() * 2_500);
      saveMode.fail = random() < 0.3;
    } else if (roll < pauseChance + 0.21) {
      await tolerate(
        () => rig.send({ type: "audio.chunk", audio: MALFORMED[Math.floor(random() * MALFORMED.length)], speaker }),
        `step ${step} malformed frame`,
      );
    } else if (roll < pauseChance + 0.27) {
      await vi.advanceTimersByTimeAsync(5_000 + Math.floor(random() * 35_000));
    } else if (roll < pauseChance + 0.29) {
      await outageStorm(step);
    } else if (roll < pauseChance + 0.305) {
      await hum(step);
    } else if (mode.crowd && roll < pauseChance + 0.335) {
      await leave(step);
    } else {
      await speakUtterance(step);
    }
    await vi.advanceTimersByTimeAsync(0);
    check(`step ${step}`);
    if (step % 6 === 5) await checkJoinedViewer(`step ${step}`);
  }

  saveMode.delayMs = 0;
  saveMode.fail = false;
  saveMode.jitter = false;
  let switchesSettled = false;
  void Promise.all(switches).then(() => {
    switchesSettled = true;
  });
  for (let round = 0; round < 10 && !switchesSettled; round += 1) {
    await vi.advanceTimersByTimeAsync(DEADLINE + 1_000);
    for (let spin = 0; spin < 50 && !switchesSettled; spin += 1) {
      await new Promise((resolve) => (spin < 20 ? realSetImmediate(resolve) : realSetTimeout(resolve, 2)));
    }
  }
  if (!switchesSettled) report("a language switch never settled");
  for (let round = 0; round < 3 && statusOf() === "paused"; round += 1) {
    await togglePause(STEPS + round);
    if (statusOf() === "paused") await vi.advanceTimersByTimeAsync(61_000);
  }
  await endTurnOf(speaker, "final turn end", "commit and clear");
  for (let round = 0; round < 4; round += 1) await vi.advanceTimersByTimeAsync(DEADLINE + 20_000);
  for (let round = 0; round < 60 && savesInFlight > 0; round += 1) await vi.advanceTimersByTimeAsync(500);
  check("end");
  if (!openai && openSarvamSockets() > 0) report(`after a long silence the room still holds ${openSarvamSockets()} open Sarvam sockets`);

  const lines = viewerLines();
  checkChunksOnce("end", lines);
  const shownWith = new Map<number, Set<string>>();
  for (const line of lines) {
    for (const { uid } of tokensOf(line.text)) {
      shownWith.set(uid, (shownWith.get(uid) ?? new Set()).add(line.itemId));
    }
  }
  const gaps = lines.filter(({ text }) => text === GAP || text.endsWith(` ${GAP}`));
  const nextLineOf = (line: Line) =>
    lines.reduce(
      (next, other) =>
        sourceOf(other) === sourceOf(line) && other.startMs > line.startMs ? Math.min(next, other.startMs) : next,
      Number.POSITIVE_INFINITY,
    );
  const stretchOf = (line: Line) => {
    const start = timeline.findIndex(({ at, who }) => at === line.startMs && who === sourceOf(line));
    if (start < 0) return [];
    let first = start;
    while (first > 0 && timeline[first - 1].who === sourceOf(line)) first -= 1;
    const until = nextLineOf(line);
    const untilNextLine = timeline.slice(start).filter(({ at, who }) => who === sourceOf(line) && at < until);
    return Array.from(new Set([...timeline.slice(first, start), ...runFrom(line), ...untilNextLine]));
  };
  const gapRuns = gaps.map((gap) => ({ gap, run: stretchOf(gap) }));
  for (const { gap, run } of gapRuns) {
    if (gap.text === GAP && !run.some(({ heard }) => heard)) {
      report(`a gap under ${gap.speakerUserId} at ${gap.startMs} covers no speech our check heard`);
    }
  }
  if (!openai) {
    for (const utterance of utterances) {
      if (!utterance.heard && shownWith.has(utterance.uid)) suiteCounters.whisperCaptions += 1;
      if (!SPOKEN.has(utterance.kind) || !answeredLive.has(utterance.uid) || shownWith.has(utterance.uid)) continue;
      report(`U${utterance.uid} (${utterance.speaker.userId}, ${utterance.kind}) was answered on an open connection but its words never showed`);
    }
  }
  if (!mode.burst) {
    for (const utterance of utterances) {
      if (!utterance.heard || !SPOKEN.has(utterance.kind) || !utterance.accepted || utterance.arrivals.length === 0) continue;
      const told = openai
        ? committedLive.has(utterance.uid)
        : startedPromptly.has(utterance.uid) || answeredLive.has(utterance.uid);
      if (!told) continue;
      const emptyAnswerOn = emptyOn.get(utterance.uid);
      const shown =
        shownWith.has(utterance.uid) ||
        gapRuns.some(({ gap, run }) => gap.speakerUserId === utterance.speaker.userId && run.some(({ uid }) => uid === utterance.uid)) ||
        (emptyAnswerOn !== undefined &&
          utterances.some((other) => answeredOn.get(other.uid)?.has(emptyAnswerOn) && shownWith.has(other.uid)));
      const closedOn = answeredAfterClose.get(utterance.uid);
      if (!shown && closedOn !== undefined && closedOn === lastCarriedOn.get(utterance.uid)) continue;
      if (!shown) report(`U${utterance.uid} (${utterance.speaker.userId}, ${utterance.kind}) was heard and sent but shows neither words nor a gap`);
    }
  }

  await checkJoinedViewer("end");

  if (savesInFlight === 0 && !lastSaveFailed && rig.snapshots.length > 0) {
    suiteCounters.restarts += 1;
    const seen = viewerLines().filter(({ text }) => text !== GAP && text.trim() !== "");
    for (const [where, kept] of [
      ["the saved transcript", (rig.snapshots.at(-1)?.segments ?? []) as Line[]],
      ["the restarted room", (await rig.restartedSegments()) as Line[]],
    ] as const) {
      const byItem = new Map(kept.map((line) => [line.itemId, line]));
      for (const line of seen) {
        const saved = byItem.get(line.itemId);
        if (!saved || saved.text !== line.text || saved.speakerUserId !== line.speakerUserId || saved.startMs !== line.startMs) {
          report(`${where} lost "${line.text}" under ${line.speakerUserId}`);
          break;
        }
      }
      const shownNow = new Map(viewerLines().map((line) => [line.itemId, line.text]));
      const stale = kept.find((line) => line.text.trim() !== "" && shownNow.get(line.itemId) !== line.text);
      if (stale) report(`${where} holds "${stale.text}" under ${stale.speakerUserId}, which viewers do not see`);
      checkSpeakers("after a restart", kept, where);
    }
  }

  if (random() < 0.3) {
    suiteCounters.failedSavesBeforeStop += 1;
    saveMode.failOnce = true;
    const last: Utterance = { uid: utterances.length, speaker, kind: "speech", arrivals: [], heard: false, accepted: true, pauseEpoch };
    utterances.push(last);
    await sendChunk(last);
  }
  await tolerate(() => rig.stop(), "stop");
  await vi.advanceTimersByTimeAsync(60_000);
  if (rig.stored.snapshot) report("a snapshot was written after notes stopped");
  const retained = rig.retainedLineState();
  if (JSON.stringify(retained) !== JSON.stringify({ lines: 0, connections: 0, unownedAudio: 0, bufferedAudio: 0, timers: 0 })) {
    report(`stopping notes left ${JSON.stringify(retained)}`);
  }
  if (rig.heldAudioBytes() !== 0) report(`stopping notes left ${rig.heldAudioBytes()} bytes of audio`);
  vi.useRealTimers();
  limit.bytes = limit.real;
  if (TRACE) {
    const fs = await import("node:fs");
    fs.writeFileSync(TRACE, traceLines.join("\n"));
    traceLines.length = 0;
  }
  return problems;
};

const sweep = async (mode: Mode) => {
  const failures: string[] = [];
  for (let seed = FIRST; seed < FIRST + RUNS && failures.length < MAX_FAILURES; seed += 1) {
    const problems = await runOnce(seed, mode);
    if (problems.length > 0) failures.push(`seed ${seed}: ${problems.join(" | ")}`);
  }
  return failures;
};

describe("captions against an independent speech script", () => {
  it(`every line names only its own speaker's speech, in order, with nothing heard lost, across ${RUNS} runs`, async () => {
    expect(await sweep({})).toEqual([]);
  }, Math.max(600_000, RUNS * 2_000));

  it(`the same holds with frequent pauses and takeovers while paused, across ${RUNS} runs`, async () => {
    expect(await sweep({ pauses: true })).toEqual([]);
  }, Math.max(600_000, RUNS * 2_000));

  it(`the audio limit keeps the newest audio and every line stays on its speaker, across ${RUNS} runs`, async () => {
    expect(await sweep({ burst: true })).toEqual([]);
  }, Math.max(600_000, RUNS * 2_000));

  it(`the same holds for six sources that join, leave and wait for a capped Sarvam lane, across ${RUNS} runs`, async () => {
    expect(await sweep({ crowd: true })).toEqual([]);
  }, Math.max(600_000, RUNS * 2_000));

  it("each hard transition happened in the runs above", () => {
    expect(Object.entries(suiteCounters).filter(([, count]) => count === 0)).toEqual([]);
  });
});
