import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptSegment } from "@conclave/meeting-core/transcript-types";
import {
  TRANSCRIPTION_GAP_MARKER as GAP,
  TRANSCRIPTION_LINE_DEADLINE_MS as DEADLINE,
} from "../transcript-worker/src/constants";
import { Pcm24To16Downsampler } from "../transcript-worker/src/transcription/sarvam";
import { VoiceActivity } from "../transcript-worker/src/transcription/voice-activity";
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
const SAME_SPEAKER_RESIDUAL_BUDGET = Number(process.env.TRANSCRIPT_ORACLE_RESIDUAL_BUDGET ?? 28);
const FIRST = Number(process.env.TRANSCRIPT_ORACLE_FROM ?? 1);
const MAX_FAILURES = Number(process.env.TRANSCRIPT_ORACLE_MAX_FAILURES ?? 3);
const STEPS = 36;
const POOL = 240;
const BURST_LIMIT_CHUNKS = 24;
const LOOKBACK_MS = 1_500;
const VAD_PAUSE_MS = 500;
const RELAY_TURN_END_MS = 1_200;
const SAVE_FAILURE = "Snapshot write failed (injected).";
const LANGUAGES = ["ta", "hi", "bn"];
const MALFORMED = ["%%%%", "@@@@AAAA", "A", "====", "AB=C", "\u0000\u0001"];
const realSetImmediate = globalThis.setImmediate.bind(globalThis);
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

const speakers = [
  { userId: "ada", displayName: "Ada" },
  { userId: "grace", displayName: "Grace" },
  { userId: "lin", displayName: "Lin" },
];
type Speaker = (typeof speakers)[number];

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
type Line = { itemId: string; text: string; speakerUserId?: string; sequence: number; startMs: number };

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
};

type Mode = { burst?: boolean; pauses?: boolean };

const runOnce = async (seed: number, mode: Mode = {}): Promise<{ problems: string[]; residuals: string[] }> => {
  const random = randomFrom(seed);
  const problems: string[] = [];
  const residuals: string[] = [];
  const report = (message: string) => {
    if (problems.length < 5) problems.push(message);
  };
  const openai = seed % 2 === 0;
  const sameSpeakerResidual = (message: string) => {
    if (openai) report(message);
    else if (residuals.length < 5) residuals.push(message);
  };
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
  const committedLive = new Set<number>();
  const used = new Map<Kind, number>(KINDS.map((kind) => [kind, 0]));
  const timeline: { at: number; speaker: string; uid: number; heard: boolean }[] = [];
  let pauseEpoch = 0;

  const fakes = new Map<FakeProviderSocket, { receive(message: Record<string, unknown>): void }>();
  const wireTurns = new Map<FakeProviderSocket, { epoch: number | null; bounded: boolean }>();
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
  ) => {
    setTimeout(() => {
      const open = !socket.closed;
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
    } | null = null;
    let lastAnswerAt = 0;
    let lastSignalAt = 0;
    let answers = 0;
    let stalled = false;
    const close = () => {
      const closing = current;
      if (!closing) return;
      current = null;
      const now = Date.now();
      if (sarvamSignals && random() < 0.9) {
        lastSignalAt = Math.max(now + 20 + random() * 200, closing.startAt + 1, lastSignalAt + 1);
        emitAt(lastSignalAt, socket, { type: "events", data: { signal_type: "END_SPEECH" } });
      }
      if (stalled) return;
      const roll = random();
      if (roll < 0.025 && !closing.falseStart) {
        stalled = true;
        suiteCounters.stalledProviders += 1;
        return;
      }
      const late = roll < 0.1;
      const at = Math.max(
        now + (late ? DEADLINE + 1_000 + random() * 34_000 : 150 + random() * 2_300),
        lastAnswerAt + 1,
        closing.startAt + 2,
      );
      lastAnswerAt = at;
      const transcript = closing.falseStart ? "" : Array.from(new Set(closing.tags.map(tokenOf))).join(" ");
      const requestId = random() < 0.1 ? null : `r${socket.requestIndex}-${(answers += 1)}`;
      const answer = { type: "data", data: { transcript, ...(requestId ? { request_id: requestId } : {}) } };
      emitAt(at, socket, answer, (open) => {
        if (late) suiteCounters.lateSarvamAnswers += 1;
        if (open && transcript) for (const { uid } of closing.utterances) answeredLive.add(uid);
      });
      if (requestId && random() < 0.04) emitAt(at, socket, answer);
    };
    const open = (tag: Tag, falseStart: boolean) => {
      const now = Date.now();
      const roll = random();
      const wanted = roll < 0.75 ? random() * 300 : roll < 0.95 ? 300 + random() * 1_100 : 1_600 + random() * 800;
      const delay = sarvamSignals ? Math.max(wanted, lastSignalAt + 1 - now) : wanted;
      if (sarvamSignals) lastSignalAt = now + delay;
      const opened = {
        tags: [tag],
        utterances: [tag.utterance],
        speaker: tag.utterance.speaker.userId,
        openedAt: now,
        heardAt: now,
        startAt: now + delay,
        falseStart,
      };
      current = opened;
      if (!sarvamSignals) return;
      emitAt(now + delay, socket, { type: "events", data: { signal_type: "START_SPEECH" } }, (live) => {
        if (live && delay <= LOOKBACK_MS - 100) for (const { uid } of opened.utterances) startedPromptly.add(uid);
      });
    };
    return {
      receive(message: Record<string, unknown>) {
        const data = (message.audio as { data?: unknown } | undefined)?.data;
        if (typeof data === "string" && data) {
          const tag = tag16.get(data);
          if (!tag) return;
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
        if (message.type === "flush" || message.type === "end_of_stream") close();
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
    let fake = fakes.get(socket);
    if (!fake) {
      fake = openaiSocket(socket) ? fakeOpenAi(socket) : fakeSarvam(socket);
      fakes.set(socket, fake);
    }
    fake.receive(message);
  };
  const openaiSocket = (socket: FakeProviderSocket) => /\/v1\/realtime/.test(socket.url);

  const rig = await transcriptRoomRig(
    lookup,
    openai ? OPENAI : SARVAM,
    { TRANSCRIPT_TOKEN_SECRET: "caption-oracle-secret" },
    { onProviderSend: (socket, message) => onWire(socket, message) },
  );
  type Store = {
    all(): readonly { audio: string; sequence: number; sentAt: number | null; owner: { kind: string; lineId?: string } }[];
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

  const saveMode = { delayMs: 0, fail: false, failOnce: false };
  let savesInFlight = 0;
  let lastSaveFailed = false;
  {
    const storage = (rig.room as unknown as {
      state: { storage: { put: (key: string, value: unknown) => Promise<void>; delete: (key: string) => Promise<boolean> } };
    }).state.storage;
    const put = storage.put.bind(storage);
    const remove = storage.delete.bind(storage);
    let writes: Promise<unknown> = Promise.resolve();
    storage.delete = (key) => {
      const done = writes.then(() => remove(key));
      writes = done.catch(() => undefined);
      return done;
    };
    storage.put = (key, value) => {
      const { delayMs } = saveMode;
      const fail = saveMode.fail || saveMode.failOnce;
      saveMode.failOnce = false;
      savesInFlight += 1;
      const write = writes.then(async () => {
        try {
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (fail) throw new Error(SAVE_FAILURE);
          await put(key, value);
          lastSaveFailed = false;
        } catch (error) {
          lastSaveFailed = true;
          throw error;
        } finally {
          savesInFlight -= 1;
        }
      });
      writes = write.catch(() => undefined);
      return write;
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
        if (before !== undefined && before !== line.itemId) sameSpeakerResidual(`${stage}: ${key} is shown in two lines`);
        shownIn.set(key, line.itemId);
      }
    }
  };

  const runsFrom = (line: Line) =>
    timeline.flatMap(({ at, speaker }, start) => {
      if (at !== line.startMs || speaker !== line.speakerUserId) return [];
      let end = start;
      while (end + 1 < timeline.length && timeline[end + 1].speaker === line.speakerUserId) end += 1;
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

  const checkStore = (stage: string) => {
    const store = internals.audio;
    const chunks = store.all();
    const total = chunks.reduce((sum, { audio }) => sum + audio.length, 0);
    if (total !== store.bytes) report(`${stage}: the store counts ${store.bytes} bytes but holds ${total}`);
    if (total > limit.bytes) report(`${stage}: the room holds ${total} bytes of audio, over the ${limit.bytes} limit`);
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
    checkStore(stage);
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
    if (pool.heard[index]) utterance.heard = true;
    trace(`send U${utterance.uid}:${utterance.speaker.userId} ${utterance.kind}#${tag.chunk} status=${status}`);
    if (utterance.accepted) {
      timeline.push({ at: Date.now(), speaker: utterance.speaker.userId, uid: utterance.uid, heard: pool.heard[index] });
    }
    await tolerate(
      () => rig.send({ type: "audio.chunk", audio: pool.wire24[index], speaker: utterance.speaker }),
      `U${utterance.uid}`,
    );
    return true;
  };

  let speaker = speakers[0];
  let paused = false;
  const switches: Promise<unknown>[] = [];

  const turnOpen = new Map<string, number>();
  const speakUtterance = async (step: number) => {
    const previous = speaker;
    if (random() < 0.35) speaker = speakers[Math.floor(random() * speakers.length)];
    for (const other of speakers) {
      const lastAt = turnOpen.get(other.userId);
      if (other === speaker || lastAt === undefined || Date.now() - lastAt < RELAY_TURN_END_MS) continue;
      turnOpen.delete(other.userId);
      await tolerate(() => rig.clear(other), `step ${step} relay turn end for ${other.userId}`);
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
      const gap = random();
      await vi.advanceTimersByTimeAsync(mode.burst ? 0 : gap < 0.4 ? 0 : gap < 0.8 ? 20 : 120 + Math.floor(random() * 330));
      check(`step ${step} U${utterance.uid} chunk ${chunk}`);
    }
    const end = random();
    trace(`driver end ${end < 0.55 ? "turn" : end < 0.65 ? "clear" : end < 0.7 ? "commit" : "none"}`);
    if (end < 0.55) {
      turnOpen.delete(speaker.userId);
      await tolerate(() => rig.endTurn(speaker), `step ${step} turn end`);
    } else if (end < 0.65) {
      suiteCounters.clearsWithoutCommit += 1;
      turnOpen.delete(speaker.userId);
      await tolerate(() => rig.clear(speaker), `step ${step} clear`);
    } else {
      turnOpen.set(speaker.userId, Date.now());
      if (end < 0.7) await tolerate(() => rig.commit(speaker), `step ${step} commit`);
    }
    await vi.advanceTimersByTimeAsync(Math.floor(random() * 800));
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
    } else {
      await speakUtterance(step);
    }
    await vi.advanceTimersByTimeAsync(0);
    check(`step ${step}`);
    if (step % 6 === 5) await checkJoinedViewer(`step ${step}`);
  }

  saveMode.delayMs = 0;
  saveMode.fail = false;
  let switchesSettled = false;
  void Promise.all(switches).then(() => {
    switchesSettled = true;
  });
  for (let round = 0; round < 10 && !switchesSettled; round += 1) {
    await vi.advanceTimersByTimeAsync(DEADLINE + 1_000);
    for (let spin = 0; spin < 50 && !switchesSettled; spin += 1) {
      await new Promise((resolve) => realSetImmediate(resolve));
    }
  }
  if (!switchesSettled) report("a language switch never settled");
  if (paused) await togglePause(STEPS);
  await tolerate(() => rig.endTurn(speaker), "final turn end");
  for (let round = 0; round < 4; round += 1) await vi.advanceTimersByTimeAsync(DEADLINE + 20_000);
  for (let round = 0; round < 60 && savesInFlight > 0; round += 1) await vi.advanceTimersByTimeAsync(500);
  check("end");

  const lines = viewerLines();
  checkChunksOnce("end", lines);
  const shownWith = new Map<number, Set<string>>();
  for (const line of lines) {
    for (const { uid } of tokensOf(line.text)) {
      shownWith.set(uid, (shownWith.get(uid) ?? new Set()).add(line.itemId));
    }
  }
  const gaps = lines.filter(({ text }) => text === GAP);
  const stretchOf = (line: Line) => {
    const start = timeline.findIndex(({ at, speaker }) => at === line.startMs && speaker === line.speakerUserId);
    if (start < 0) return [];
    let first = start;
    while (first > 0 && timeline[first - 1].speaker === line.speakerUserId) first -= 1;
    return [...timeline.slice(first, start), ...runFrom(line)];
  };
  const gapRuns = gaps.map((gap) => ({ gap, run: stretchOf(gap) }));
  for (const { gap, run } of gapRuns) {
    if (!run.some(({ heard }) => heard)) {
      sameSpeakerResidual(`a gap under ${gap.speakerUserId} at ${gap.startMs} covers no speech our check heard`);
    }
  }
  if (!mode.burst) {
    for (const utterance of utterances) {
      if (!utterance.heard || !SPOKEN.has(utterance.kind) || !utterance.accepted || utterance.arrivals.length === 0) continue;
      const told = openai
        ? committedLive.has(utterance.uid)
        : startedPromptly.has(utterance.uid) || answeredLive.has(utterance.uid);
      if (!told) continue;
      const shown =
        shownWith.has(utterance.uid) ||
        gapRuns.some(({ gap, run }) => gap.speakerUserId === utterance.speaker.userId && run.some(({ uid }) => uid === utterance.uid));
      if (!shown) sameSpeakerResidual(`U${utterance.uid} (${utterance.speaker.userId}, ${utterance.kind}) was heard and sent but shows neither words nor a gap`);
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
  return { problems, residuals };
};

const residualRuns: string[] = [];

const sweep = async (mode: Mode) => {
  const failures: string[] = [];
  for (let seed = FIRST; seed < FIRST + RUNS && failures.length < MAX_FAILURES; seed += 1) {
    const { problems, residuals } = await runOnce(seed, mode);
    if (problems.length > 0) failures.push(`seed ${seed}: ${problems.join(" | ")}`);
    if (residuals.length > 0) residualRuns.push(`${JSON.stringify(mode)} seed ${seed}: ${residuals.join(" | ")}`);
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

  it("each hard transition happened in the runs above", () => {
    expect(Object.entries(suiteCounters).filter(([, count]) => count === 0)).toEqual([]);
  });

  it(`Sarvam answers that drift within one speaker's lane stay under ${SAME_SPEAKER_RESIDUAL_BUDGET} runs`, () => {
    if (process.env.TRANSCRIPT_ORACLE_SHOW_RESIDUALS) console.info(residualRuns.join("\n"));
    expect(residualRuns.length).toBeLessThanOrEqual(SAME_SPEAKER_RESIDUAL_BUDGET);
  });
});
