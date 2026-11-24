import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPTION_GAP_MARKER as GAP,
  TRANSCRIPTION_LINE_DEADLINE_MS as DEADLINE,
  UNOWNED_AUDIO_KEPT_MS as KEPT,
} from "../transcript-worker/src/constants";
import { pcmBase64, silencePcm, voicedPcm } from "./transcript-audio-fixtures";
import {
  FakeProviderSocket,
  OPENAI,
  SARVAM,
  openAiCommitted,
  openAiDelta,
  openAiFinal,
  sarvamFinal,
  sarvamSpeechEnd,
  sarvamSpeechStart,
  settle,
  transcriptRoomRig,
} from "./transcript-room-rig";

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
});

const RUNS = Number(process.env.TRANSCRIPT_CHUNK_ORDER_RUNS ?? 300);
const EXTENDED_RUNS = Number(process.env.TRANSCRIPT_CHUNK_ORDER_EXTENDED_RUNS ?? 300);
const BURST_RUNS = Number(process.env.TRANSCRIPT_CHUNK_ORDER_BURST_RUNS ?? 200);
const PAUSE_RUNS = Number(process.env.TRANSCRIPT_CHUNK_ORDER_PAUSE_RUNS ?? 200);
const SMALL_CAP_RUNS = Number(process.env.TRANSCRIPT_CHUNK_ORDER_SMALL_CAP_RUNS ?? 150);
const LIMIT_CHUNKS = 24;
const MALFORMED = ["%%%%", "@@@@AAAA", "A", "====", "AB=C", "\u0000\u0001"];
const LANGUAGES = ["ta", "hi", "bn"];
const SAVE_FAILURE = "Snapshot write failed (injected).";
const STEPS = 40;
const POOL = 400;
const realSetImmediate = globalThis.setImmediate.bind(globalThis);

const VOICED = Array.from({ length: POOL }, (_, index) => pcmBase64(voicedPcm(-26, 200, 110 + index * 0.37)));
const QUIET = Array.from({ length: POOL }, (_, index) => {
  const samples = silencePcm();
  samples[index % samples.length] = 1 + (index % 7);
  return pcmBase64(samples);
});

const speakers = [
  { userId: "ada", displayName: "Ada" },
  { userId: "grace", displayName: "Grace" },
  { userId: "lin", displayName: "Lin" },
];

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

type Sent = { index: number; speaker: string; voiced: boolean; at: number; turn: number; run: number };
type HeldChunk = { audio: string; turn?: number };
type Line = {
  id: string;
  speaker: { userId: string };
  audio: HeldChunk[];
  state: string;
  epoch: number | null;
  heard: boolean;
  text: string;
  place: { sequence: number; startMs: number };
};
type Ledger = {
  all(): Line[];
  activeUnordered(): Line[];
  active(): Line[];
  get(id: string): Line | undefined;
  end(line: Line, ...rest: unknown[]): void;
  remove(id: string): void;
};
type RoomInternals = {
  ledger: Ledger;
  uncommittedAudio: Map<string, { speaker: { userId: string }; chunks: HeldChunk[] }>;
  transcriptionRecoveryAudio: {
    chunks(): HeldChunk[];
    enqueueMany(events: { type: string; audio?: string }[], ...rest: unknown[]): void;
  };
  segments: SavedLine[];
  session: { status?: string } | null;
  state: { storage: { put: (key: string, value: unknown) => Promise<void> } };
  keepReplayAudioWithinLimit: () => void;
};
type SavedLine = { itemId: string; text: string; speakerUserId?: string; sequence: number };
type Mode = { extended?: boolean; bursts?: boolean; pauses?: boolean; smallCap?: boolean };

const wordsOf = (text: string) => text.split(/\s+/).filter(Boolean);
const keepsWordsInOrder = (kept: string, seen: string) => {
  const keptWords = wordsOf(kept);
  let at = 0;
  for (const word of wordsOf(seen)) {
    while (at < keptWords.length && keptWords[at] !== word) at += 1;
    if (at === keptWords.length) return false;
    at += 1;
  }
  return true;
};

const audioCount = (socket: FakeProviderSocket) =>
  socket.sent.filter((message) => {
    const audio = (message as { audio?: unknown }).audio;
    return typeof audio === "string" || Boolean((audio as { data?: string } | undefined)?.data);
  }).length;

const runOnce = async (seed: number, mode: Mode = {}): Promise<string[]> => {
  const extended = Boolean(mode.extended || mode.bursts || mode.pauses || mode.smallCap);
  const bursts = Boolean(mode.bursts);
  const random = randomFrom(seed);
  const pauseRandom = randomFrom(seed * 7919 + 17);
  const problems: string[] = [];
  limit.bytes = bursts || mode.smallCap ? VOICED[0].length * LIMIT_CHUNKS : limit.real;
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  const openai = extended && seed % 3 === 0;
  const forwardedWhilePaused: string[] = [];
  const rig = await transcriptRoomRig(
    lookup,
    openai ? OPENAI : SARVAM,
    {
      TRANSCRIPT_TOKEN_SECRET: "chunk-order-secret",
      ...(mode.smallCap ? { TRANSCRIPT_MAX_SEGMENTS: String(1 + (Math.floor(seed / 3) % 3)) } : {}),
    },
    {
      onProviderSend: (providerSocket, message) => {
        const audio = (message as { audio?: unknown }).audio;
        const carriesAudio = typeof audio === "string" || Boolean((audio as { data?: string } | undefined)?.data);
        const status = (rig?.room as unknown as RoomInternals | undefined)?.session?.status;
        if (carriesAudio && status === "paused") {
          forwardedWhilePaused.push(`request ${providerSocket.requestIndex}`);
        }
      },
    },
  );
  await rig.start(openai ? "en" : "hi");
  let acked = 0;
  const openItems: string[] = [];
  const signal = () => {
    if (!openai) return latestSocket().emit(sarvamSpeechStart());
    const itemId = `c${acked++}`;
    openItems.push(itemId);
    latestSocket().emit(openAiCommitted(itemId));
  };
  const speechEnd = () => {
    if (!openai) return latestSocket().emit(sarvamSpeechEnd());
    const itemId = openItems[Math.floor(random() * openItems.length)];
    if (itemId) latestSocket().emit(openAiDelta(itemId, "and "));
  };
  const answer = (itemId: string, text: string) => {
    if (!openai) return latestSocket().emit(sarvamFinal(itemId, text));
    const open = openItems.shift();
    if (open) latestSocket().emit(openAiFinal(open, text));
  };
  const room = rig.room as unknown as RoomInternals;
  let socket = rig.providerSockets().at(-1)!;
  const latestSocket = () =>
    (rig.room as unknown as { liveConnection: { session: { socket?: FakeProviderSocket } } | null }).liveConnection
      ?.session.socket ?? rig.providerSockets().at(-1)!;
  const sent = new Map<string, Sent>();
  const order: Sent[] = [];
  const lastHolder = new Map<string, string>();
  const audioAtOrder = new Map<number, string>();
  const placedAt = new Map<string, number>();
  const shown = new Set<string>();
  const endedChunkLine = new Map<string, string>();
  const roomTurn = new Map<string, number>();
  const runOf = new Map<number, number>();
  const removed = new Set<string>();
  const everHeld = new Set<string>();
  const evicted = new Set<string>();
  const sentWhilePaused = new Set<string>();
  const ledger = room.ledger;
  const end = ledger.end.bind(ledger);
  ledger.end = (line, ...rest) => {
    for (const chunk of line.audio) endedChunkLine.set(chunk.audio, line.id);
    end(line, ...rest);
  };
  const remove = ledger.remove.bind(ledger);
  ledger.remove = (id) => {
    const line = ledger.get(id);
    const ended = line && (line.state === "final" || line.state === "gap" || line.state === "dropped");
    for (const chunk of line?.audio ?? []) {
      if (ended) endedChunkLine.set(chunk.audio, line.id);
      else removed.add(chunk.audio);
    }
    remove(id);
  };
  const countedByLimit = () => [
    ...room.ledger.activeUnordered().flatMap(({ audio }) => audio),
    ...Array.from(room.uncommittedAudio.values()).flatMap(({ chunks }) => chunks),
    ...room.transcriptionRecoveryAudio.chunks(),
  ];
  const recordEvictions = (before: string[]) => {
    const after = new Set(countedByLimit().map(({ audio }) => audio));
    const dropped = before.filter((audio) => !after.has(audio) && sent.has(audio));
    if (dropped.length === 0) return;
    const newestDropped = Math.max(...dropped.map((audio) => sent.get(audio)!.index));
    const oldestKept = [...after]
      .map((audio) => sent.get(audio))
      .filter((info): info is Sent => info !== undefined)
      .sort((left, right) => left.index - right.index)[0];
    if (oldestKept && oldestKept.index < newestDropped) {
      report(`the audio limit dropped #${newestDropped} but kept older ${describeChunk(oldestKept)}`);
    }
    for (const audio of dropped) evicted.add(audio);
  };
  const keepWithinLimit = room.keepReplayAudioWithinLimit.bind(room);
  room.keepReplayAudioWithinLimit = () => {
    const before = countedByLimit().map(({ audio }) => audio);
    keepWithinLimit();
    recordEvictions(before);
  };
  const buffer = room.transcriptionRecoveryAudio;
  const enqueueMany = buffer.enqueueMany.bind(buffer);
  buffer.enqueueMany = (events, ...rest) => {
    const before = [
      ...countedByLimit().map(({ audio }) => audio),
      ...events.flatMap((event) => ("audio" in event && typeof event.audio === "string" ? [event.audio] : [])),
    ];
    enqueueMany(events, ...rest);
    recordEvictions(before);
  };
  let paused = false;
  let speaker = speakers[0];
  let turn = 0;
  let run = 0;
  let previousSpeaker = "";
  const saveMode = { delayMs: 0, fail: false };
  let savesInFlight = 0;
  let lastSaveFailed = false;
  const delivered = new Set<string>();
  const audioAtSwitch = new Map<FakeProviderSocket, number>();
  let switchFloor = -1;
  let liveAtSwitch: FakeProviderSocket | null = null;
  let replacedAt: number | null = null;
  let sentSinceSwitch = 0;
  const liveSocket = () =>
    (rig.room as unknown as { liveConnection: { session: { socket?: FakeProviderSocket } } | null }).liveConnection
      ?.session.socket ?? null;
  const switches: Promise<unknown>[] = [];
  {
    const put = room.state.storage.put.bind(room.state.storage);
    let writes: Promise<unknown> = Promise.resolve();
    room.state.storage.put = (key, value) => {
      const { delayMs, fail } = saveMode;
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

  const report = (message: string) => {
    if (problems.length < 5) problems.push(message);
  };

  const describeChunk = (info: Sent) => `#${info.index} ${info.speaker}`;

  const seenByViewers = () => {
    const viewer = rig.viewerTranscript();
    return [...viewer.segments, ...viewer.partials.values()]
      .filter(({ text }) => text.trim() !== "" && text !== GAP)
      .sort((left, right) => left.sequence - right.sequence);
  };

  const retainedByRoom = () =>
    new Set([...room.segments.map(({ itemId }) => itemId), ...room.ledger.activeUnordered().map(({ id }) => id)]);

  const checkKept = (stage: string, kept: SavedLine[], where: string) => {
    const byItem = new Map(kept.map((line) => [line.itemId, line]));
    const retained = mode.smallCap ? retainedByRoom() : null;
    const seen = seenByViewers().filter(({ itemId }) => !retained || retained.has(itemId));
    for (const line of seen) {
      const saved = byItem.get(line.itemId);
      if (!saved || !keepsWordsInOrder(saved.text, line.text) || saved.speakerUserId !== line.speakerUserId) {
        report(
          `${stage}: viewers saw "${line.text}" under ${line.speakerUserId} but ${where} holds ${
            saved ? `"${saved.text}" under ${saved.speakerUserId}` : "nothing"
          }`,
        );
        return;
      }
    }
    const seenOrder = seen.map(({ itemId }) => itemId);
    const keptOrder = [...kept]
      .sort((left, right) => left.sequence - right.sequence)
      .map(({ itemId }) => itemId)
      .filter((itemId) => seenOrder.includes(itemId));
    if (keptOrder.join() !== seenOrder.join()) {
      report(`${stage}: viewers saw lines in the order ${seenOrder.join(",")} but ${where} keeps ${keptOrder.join(",")}`);
    }
  };

  const checkViewers = (stage: string) => {
    const viewer = rig.viewerTranscript();
    const finals = new Map(viewer.segments.map((segment) => [segment.itemId, segment]));
    for (const segment of room.segments) {
      const seen = finals.get(segment.itemId);
      const want = [segment.text, segment.speakerUserId, segment.sequence];
      const got = seen ? [seen.text, seen.speakerUserId, seen.sequence] : null;
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        report(`${stage}: the room shows ${JSON.stringify(want)} for ${segment.itemId} but viewers have ${JSON.stringify(got)}`);
        return;
      }
    }
    for (const line of room.ledger.activeUnordered()) {
      if (!line.text) continue;
      const seen = viewer.partials.get(line.id);
      const want = [line.text, line.speaker.userId, line.place.sequence];
      const got = seen ? [seen.text, seen.speakerUserId, seen.sequence] : null;
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        report(`${stage}: the room shows live ${JSON.stringify(want)} for ${line.id} but viewers have ${JSON.stringify(got)}`);
        return;
      }
    }
    if (savesInFlight === 0 && !lastSaveFailed) {
      checkKept(stage, (rig.snapshots.at(-1)?.segments ?? []) as SavedLine[], "the saved transcript");
    }
    if (forwardedWhilePaused.length > 0) {
      report(`${stage}: a provider (${forwardedWhilePaused[0]}) received audio while captions were paused`);
      forwardedWhilePaused.length = 0;
    }
  };

  const check = (stage: string) => {
    const now = Date.now();
    checkViewers(stage);
    const viewerFinalIds = new Set(rig.viewerTranscript().segments.map(({ itemId }) => itemId));
    for (const [audio, lineId] of endedChunkLine) {
      if (viewerFinalIds.has(lineId)) shown.add(audio);
    }
    const holders = new Map<string, string>();
    const hold = (audio: string, holder: string) => {
      if (!sent.has(audio)) return;
      const earlier = holders.get(audio);
      if (earlier) report(`${stage}: ${describeChunk(sent.get(audio)!)} held twice (${earlier}, ${holder})`);
      holders.set(audio, holder);
    };
    for (const line of room.ledger.all()) {
      const ended = line.state === "final" || line.state === "gap" || line.state === "dropped";
      const indices: number[] = [];
      for (const chunk of line.audio) {
        const info = sent.get(chunk.audio);
        if (!info) continue;
        hold(chunk.audio, `line ${line.id}`);
        if (ended && viewerFinalIds.has(line.id)) shown.add(chunk.audio);
        if (info.speaker !== line.speaker.userId) {
          report(`${stage}: ${describeChunk(info)} shown under ${line.speaker.userId}`);
        }
        indices.push(info.index);
      }
      if (indices.some((value, at) => at > 0 && value <= indices[at - 1])) {
        report(`${stage}: line ${line.id} holds chunks out of send order ${indices.join(",")}`);
      }
      if (indices.length > 1) {
        const first = indices[0];
        const last = indices[indices.length - 1];
        const crossed = order.find(
          (other) =>
            other.index > first &&
            other.index < last &&
            other.speaker !== line.speaker.userId &&
            !sentWhilePaused.has((other.voiced ? VOICED : QUIET)[other.index]),
        );
        if (crossed) report(`${stage}: line ${line.id} spans ${describeChunk(crossed)} from another speaker`);
      }
    }
    for (const [, pending] of room.uncommittedAudio) {
      for (const chunk of pending.chunks) {
        hold(chunk.audio, "unowned");
        if (chunk.turn !== undefined) roomTurn.set(chunk.audio, chunk.turn);
      }
    }
    for (const chunk of room.transcriptionRecoveryAudio.chunks()) hold(chunk.audio, "buffered");
    const learnOrder = (chunk: HeldChunk) => {
      const order = (chunk as HeldChunk & { order?: number }).order;
      if (order !== undefined) audioAtOrder.set(order, chunk.audio);
    };
    for (const line of room.ledger.all()) line.audio.forEach(learnOrder);
    for (const [, pending] of room.uncommittedAudio) pending.chunks.forEach(learnOrder);
    room.transcriptionRecoveryAudio.chunks().forEach(learnOrder);
    for (const line of room.ledger.all()) {
      const placeAudio = audioAtOrder.get(line.place.sequence);
      if (!placeAudio) continue;
      const placeInfo = sent.get(placeAudio);
      if (placeInfo && line.place.startMs !== placeInfo.at) {
        report(`${stage}: line ${line.id} starts at ${line.place.startMs}, not when its first audio reached the room (${placeInfo.at})`);
      }
      const before = placedAt.get(line.id);
      if (before !== undefined && line.place.sequence > before) {
        const firstAudio = audioAtOrder.get(before);
        const nowHeldBy = firstAudio ? holders.get(firstAudio) : undefined;
        if (!nowHeldBy || nowHeldBy === `line ${line.id}`) {
          report(`${stage}: line ${line.id} moved from place ${before} to ${line.place.sequence} without giving its first audio to another line`);
        }
      }
      placedAt.set(line.id, line.place.sequence);
    }
    if (switchFloor >= 0) {
      const live = liveSocket();
      if (replacedAt === null && live && live.requestIndex >= switchFloor) {
        replacedAt = liveAtSwitch ? audioCount(liveAtSwitch) : 0;
        for (const [audio, holder] of lastHolder) if (holder !== "buffered") delivered.add(audio);
        if (liveAtSwitch) {
          for (const info of order.slice(sentSinceSwitch)) {
            const audio = (info.voiced ? VOICED : QUIET)[info.index];
            if (!holders.has(audio)) delivered.add(audio);
          }
        }
      }
      for (const providerSocket of rig.providerSockets()) {
        if (providerSocket.requestIndex >= switchFloor) continue;
        if (providerSocket === liveAtSwitch) {
          if (replacedAt !== null && audioCount(providerSocket) > replacedAt) {
            report(`${stage}: the replaced provider (request ${providerSocket.requestIndex}) received audio after its replacement went live`);
          }
          continue;
        }
        if (audioCount(providerSocket) > (audioAtSwitch.get(providerSocket) ?? 0)) {
          report(`${stage}: a superseded connection (request ${providerSocket.requestIndex}) received audio after a switch`);
        }
      }
    }
    const wasUnowned = [...lastHolder]
      .filter(([, holder]) => holder === "unowned")
      .map(([audio]) => ({ audio, info: sent.get(audio)! }))
      .sort((left, right) => left.info.index - right.info.index);
    const lastUnownedInTurn = new Map<string, number>();
    const lastInUnownedRun = new Map<number, number>();
    let runStart = -1;
    wasUnowned.forEach(({ audio, info }, at) => {
      const key = `${info.speaker}:${roomTurn.get(audio)}`;
      lastUnownedInTurn.set(key, Math.max(lastUnownedInTurn.get(key) ?? 0, info.at));
      const previous = wasUnowned[at - 1]?.info;
      if (!previous || previous.index + 1 !== info.index || previous.speaker !== info.speaker) runStart = info.index;
      lastInUnownedRun.set(runStart, info.at);
      runOf.set(info.index, runStart);
    });
    for (const audio of holders.keys()) everHeld.add(audio);
    for (const audio of shown) everHeld.add(audio);
    if (extended) {
      for (const info of order) {
        if (!info.voiced || info.index >= order.length - 1) continue;
        const audio = VOICED[info.index];
        if (!everHeld.has(audio) && !delivered.has(audio) && !sentWhilePaused.has(audio)) {
          report(`${stage}: ${describeChunk(info)} was dropped on arrival`);
          everHeld.add(audio);
        }
      }
    }
    const activeLines = new Set(room.ledger.activeUnordered().map(({ id }) => `line ${id}`));
    for (const [audio, holder] of lastHolder) {
      if (holders.has(audio) || shown.has(audio)) continue;
      const info = sent.get(audio)!;
      if (!info.voiced) continue;
      if (removed.has(audio)) {
        report(`${stage}: ${describeChunk(info)} dropped with its line`);
        continue;
      }
      if (delivered.has(audio)) continue;
      if (evicted.has(audio)) continue;
      if (holder.startsWith("line ") && !activeLines.has(holder)) {
        report(`${stage}: ${describeChunk(info)} left ${holder}, which ended without viewers receiving it`);
        continue;
      }
      if (holder === "unowned") {
        const lastInTurn = lastUnownedInTurn.get(`${info.speaker}:${roomTurn.get(audio)}`) ?? info.at;
        const lastInRun = lastInUnownedRun.get(runOf.get(info.index) ?? info.index) ?? info.at;
        if (now - lastInTurn > KEPT || now - lastInRun > KEPT) continue;
      }
      report(`${stage}: ${describeChunk(info)} lost from ${holder}`);
    }
    lastHolder.clear();
    for (const [audio, holder] of holders) lastHolder.set(audio, holder);
  };

  const checkReplay = (stage: string) => {
    const owed = room.ledger.active().filter(({ state, epoch }) => state === "replaying" && epoch === null);
    const indices = owed.flatMap((line) => line.audio.map((chunk) => sent.get(chunk.audio)?.index ?? -1)).filter((value) => value >= 0);
    if (new Set(indices).size !== indices.length) report(`${stage}: a chunk is replayed twice ${indices.join(",")}`);
    if (indices.some((value, at) => at > 0 && value <= indices[at - 1])) {
      report(`${stage}: replay out of send order ${indices.join(",")}`);
    }
  };

  const sendChunk = async (voiced: boolean) => {
    const index = order.length;
    if (index >= POOL) return false;
    if (speaker.userId !== previousSpeaker) {
      run += 1;
      previousSpeaker = speaker.userId;
    }
    const audio = (voiced ? VOICED : QUIET)[index];
    const info = { index, speaker: speaker.userId, voiced, at: Date.now(), turn, run };
    sent.set(audio, info);
    order.push(info);
    if (room.session?.status === "paused") sentWhilePaused.add(audio);
    await tolerate(() => rig.send({ type: "audio.chunk", audio, speaker }), `chunk #${index}`);
    return true;
  };

  const togglePause = async (step: number) => {
    const wanted = !paused;
    let answered = false;
    void tolerate(() => rig.send({ type: wanted ? "session.pause" : "session.resume" }), `step ${step} pause`).then(() => {
      answered = true;
    });
    for (let round = 0; round < 20 && !answered; round += 1) await vi.advanceTimersByTimeAsync(250);
    const status = room.session?.status;
    paused = status === "paused";
  };

  const burst = async (step: number) => {
    if (random() < 0.4) {
      rig.connectPlans.push(random() < 0.5 ? "unreachable" : { lateMs: 200 + Math.floor(random() * 2_300) });
      latestSocket().disconnect();
      await settle();
      check(`step ${step} burst drop`);
    }
    const count = Math.floor(LIMIT_CHUNKS / 2) + Math.floor(random() * LIMIT_CHUNKS);
    for (let chunk = 0; chunk < count; chunk += 1) {
      if (random() < 0.15) speaker = speakers[Math.floor(random() * speakers.length)];
      if (!(await sendChunk(true))) break;
      check(`step ${step} burst chunk ${chunk}`);
    }
  };

  const sameMillisecondLines = async (step: number) => {
    const live = liveSocket();
    const queued = (room as unknown as { liveConnection: { commitQueue: unknown[] } | null }).liveConnection?.commitQueue.length;
    if (!live || queued !== 0) return;
    await sendChunk(false);
    await rig.commit(speaker);
    await sendChunk(true);
    await rig.commit(speaker);
    signal();
    signal();
    const heard = openItems.at(-1)!;
    await vi.advanceTimersByTimeAsync(DEADLINE + 2_000);
    check(`step ${step} same-millisecond lines ended`);
    if (liveSocket() !== live) return;
    live.emit(openAiFinal(heard, `Late ${step}.`));
    await settle();
    if (!rig.viewerTranscript().segments.some(({ text }) => text === `Late ${step}.`)) {
      report(`step ${step}: a late answer could not fill the gap of a line that ended in the same millisecond as another`);
    }
  };

  const owedAnswers = async (step: number) => {
    const live = liveSocket();
    const session = (room as unknown as {
      liveConnection: { session: { awaitingFinal?: string[]; expiredSlots?: Map<string, number> } } | null;
    }).liveConnection?.session;
    if (!live || (session?.awaitingFinal?.length ?? 1) !== 0 || (session?.expiredSlots?.size ?? 1) !== 0) return;
    await rig.endTurn(speaker);
    turn += 1;
    await vi.advanceTimersByTimeAsync(3_200);
    check(`step ${step} owed answers start`);
    if ((session?.awaitingFinal?.length ?? 1) !== 0) return;
    for (let utterance = 0; utterance < 18; utterance += 1) {
      speaker = speakers[utterance % speakers.length];
      if (!(await sendChunk(true))) return;
      check(`step ${step} owed utterance ${utterance}`);
      live.emit(sarvamSpeechStart());
      await rig.endTurn(speaker);
      turn += 1;
      await vi.advanceTimersByTimeAsync(500);
      check(`step ${step} owed utterance ${utterance} ended`);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    speaker = speakers[Math.floor(random() * speakers.length)];
    const freshSpeaker = speaker.userId;
    if (!(await sendChunk(true))) return;
    check(`step ${step} fresh utterance`);
    live.emit(sarvamSpeechStart());
    await rig.endTurn(speaker);
    turn += 1;
    await vi.advanceTimersByTimeAsync(DEADLINE - 9_000);
    check(`step ${step} owed answers timed out`);
    if (liveSocket() !== live) return;
    const talker = speakers[Math.floor(random() * speakers.length)];
    const shownUnder = () => rig.viewerTranscript().segments.filter(({ speakerUserId }) => speakerUserId === talker.userId).length;
    const activeIdsBefore = new Set(room.ledger.activeUnordered().map(({ id }) => id));
    const shownBefore = shownUnder();
    speaker = talker;
    if (!(await sendChunk(true))) return;
    live.emit(sarvamSpeechStart());
    for (let chunk = 0; chunk < 6; chunk += 1) {
      await vi.advanceTimersByTimeAsync(120);
      if (!(await sendChunk(true))) return;
      check(`step ${step} refused speech ${chunk}`);
    }
    const dropped = random() < 0.5;
    if (dropped) {
      live.disconnect();
    } else {
      live.emit(sarvamSpeechEnd());
      await rig.endTurn(talker);
      turn += 1;
    }
    await vi.advanceTimersByTimeAsync(3_000);
    check(`step ${step} refused speech ended`);
    const newActive = room.ledger
      .activeUnordered()
      .filter(({ id, speaker: lineSpeaker }) => !activeIdsBefore.has(id) && lineSpeaker.userId === talker.userId);
    if (shownUnder() - shownBefore !== 1 || newActive.length > 0) {
      report(`step ${step}: one refused utterance by ${talker.userId} opened ${shownUnder() - shownBefore} shown and ${newActive.length} live lines`);
    }
    if (dropped || liveSocket() !== live) return;
    for (let utterance = 0; utterance < 18; utterance += 1) live.emit(sarvamFinal(`late${step}`, `Late ${step} ${utterance}.`));
    live.emit(sarvamFinal(`fresh${step}`, `Fresh ${step}.`));
    live.emit(sarvamFinal(`refused${step}`, `Refused ${step}.`));
    await settle();
    const seen = rig.viewerTranscript().segments;
    const misplaced = seen.filter(({ text }) => text.startsWith(`Late ${step} `) || text === `Refused ${step}.`);
    if (misplaced.length > 0) report(`step ${step}: an owed answer reached a newer line (${misplaced.map(({ text }) => text).join(", ")})`);
    const fresh = seen.find(({ text }) => text === `Fresh ${step}.`);
    if (!fresh || fresh.speakerUserId !== freshSpeaker) {
      report(`step ${step}: the newest line's answer shows as ${fresh ? `${fresh.text} under ${fresh.speakerUserId}` : "nothing"}, not under ${freshSpeaker}`);
    }
  };

  const extendedEvent = async (step: number) => {
    if (mode.smallCap && openai && random() < 0.4) {
      await sameMillisecondLines(step);
      return;
    }
    if (mode.smallCap && !openai && random() < 0.25) {
      await owedAnswers(step);
      return;
    }
    const pick = random();
    if (pick < 0.18) {
      saveMode.delayMs = random() < 0.5 ? 0 : Math.floor(random() * 2_500);
      saveMode.fail = random() < 0.3;
    } else if (pick < 0.36) {
      for (const [audio, holder] of lastHolder) if (holder !== "buffered") delivered.add(audio);
      switchFloor = rig.providerRequestCount();
      liveAtSwitch = liveSocket();
      replacedAt = null;
      sentSinceSwitch = order.length;
      for (const providerSocket of rig.providerSockets()) audioAtSwitch.set(providerSocket, audioCount(providerSocket));
      const language = LANGUAGES[Math.floor(random() * LANGUAGES.length)];
      switches.push(tolerate(() => rig.switchTo(language), `step ${step} switch`));
    } else if (pick < 0.5) {
      if (random() < 0.5) rig.connectPlans.push("unreachable");
      rig.connectPlans.push({ lateMs: 200 + Math.floor(random() * 2_300) });
      latestSocket().disconnect();
    } else if (pick < 0.72) {
      if (openai) {
        const itemId = openItems[Math.floor(random() * openItems.length)];
        if (itemId) latestSocket().emit(openAiDelta(itemId, `Said ${step} `));
        return;
      }
      if (random() < 0.35) speaker = speakers[Math.floor(random() * speakers.length)];
      await vi.advanceTimersByTimeAsync(3_200);
      check(`step ${step} before short line`);
      const adapter = (rig.room as unknown as {
        liveConnection: { session: { openedBeforeSignal?: string[]; unheardSignals?: unknown[]; signalsSpeech?: boolean } } | null;
      }).liveConnection?.session;
      const clean =
        adapter?.signalsSpeech === true &&
        (adapter.openedBeforeSignal?.length ?? 1) === 0 &&
        (adapter.unheardSignals?.length ?? 1) === 0;
      if (!(await sendChunk(true))) return;
      latestSocket().emit(sarvamSpeechStart());
      latestSocket().emit(sarvamFinal(`s${step}`, `Short ${step}.`));
      latestSocket().emit(sarvamSpeechStart());
      const more = 1 + Math.floor(random() * 3);
      const continuing: string[] = [];
      for (let chunk = 0; chunk < more; chunk += 1) {
        await vi.advanceTimersByTimeAsync(80 + Math.floor(random() * 120));
        if (await sendChunk(true)) continuing.push(VOICED[order.length - 1]);
        check(`step ${step} short line ${chunk}`);
      }
      await vi.advanceTimersByTimeAsync(1_600);
      check(`step ${step} short line settled`);
      const unclaimed = continuing.filter((audio) => lastHolder.get(audio) === "unowned");
      if (clean && unclaimed.length > 0) {
        report(`step ${step}: speech after an early START was left unclaimed (${unclaimed.map((audio) => describeChunk(sent.get(audio)!)).join(", ")})`);
      }
    } else if (pick < 0.86) {
      const frame = MALFORMED[Math.floor(random() * MALFORMED.length)];
      try {
        await rig.send({ type: "audio.chunk", audio: frame, speaker });
      } catch (error) {
        report(`step ${step}: a malformed frame threw ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      const closed = rig.providerSockets().filter(({ closed }) => closed);
      if (closed.length === 0) return;
      const target = closed[Math.floor(random() * closed.length)];
      const before = JSON.stringify([
        room.ledger.all().map(({ id, state, text }) => [id, state, text]),
        room.segments.map(({ itemId, text }) => [itemId, text]),
      ]);
      if (openai) {
        target.emit(openAiCommitted(`late${step}`));
        target.emit(openAiFinal(`late${step}`, `Late ${step}.`));
      } else {
        target.emit(sarvamSpeechStart());
        target.emit(sarvamFinal(`late${step}`, `Late ${step}.`));
      }
      await settle();
      const after = JSON.stringify([
        room.ledger.all().map(({ id, state, text }) => [id, state, text]),
        room.segments.map(({ itemId, text }) => [itemId, text]),
      ]);
      if (before !== after) report(`step ${step}: a closed connection changed the room`);
    }
  };

  await sendChunk(true);
  if (!openai) socket.emit(sarvamSpeechStart());
  await rig.endTurn(speaker);
  turn += 1;
  if (openai) signal();
  answer("setup", "Setup.");
  await vi.advanceTimersByTimeAsync(2_000);
  check("setup");

  for (let step = 0; step < STEPS; step += 1) {
    if (mode.pauses && pauseRandom() < 0.15) {
      await togglePause(step);
      check(`step ${step} pause`);
    }
    if (bursts && random() < 0.2) {
      await burst(step);
      await settle();
      socket = latestSocket();
      check(`step ${step} burst`);
      continue;
    }
    if (extended && random() < 0.3) {
      await extendedEvent(step);
      await settle();
      socket = latestSocket();
      check(`step ${step} extended`);
      continue;
    }
    const roll = random();
    if (roll < 0.5) {
      if (random() < 0.35) speaker = speakers[Math.floor(random() * speakers.length)];
      const monologue = random() < 0.08;
      const count = monologue ? 20 + Math.floor(random() * 25) : 1 + Math.floor(random() * 3);
      for (let chunk = 0; chunk < count; chunk += 1) {
        await sendChunk(monologue || random() < 0.85);
        const gap = random();
        await vi.advanceTimersByTimeAsync(monologue ? 150 : gap < 0.45 ? 0 : gap < 0.85 ? 20 : 100 + Math.floor(random() * 400));
        check(`step ${step} chunk ${chunk}`);
      }
    } else if (roll < 0.58) {
      await rig.endTurn(speaker);
      turn += 1;
    } else if (roll < 0.74) {
      const delay = random() < 0.5 ? 0 : Math.floor(random() * 1_200);
      if (delay) await vi.advanceTimersByTimeAsync(delay);
      signal();
    } else if (roll < 0.8) {
      speechEnd();
    } else if (roll < 0.93) {
      answer(`f${step}`, `Words ${step}.`);
    } else {
      socket.disconnect();
      checkReplay(`step ${step} drop`);
      await settle();
      socket = latestSocket();
    }
    await settle();
    check(`step ${step}`);
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
  await vi.advanceTimersByTimeAsync(DEADLINE + 1_000);
  for (let round = 0; round < 60 && savesInFlight > 0; round += 1) await vi.advanceTimersByTimeAsync(500);
  check("end");
  if (savesInFlight === 0 && !lastSaveFailed && rig.snapshots.length > 0) {
    checkKept("after a restart", (await rig.restartedSegments()) as SavedLine[], "the restarted room");
  }
  vi.useRealTimers();
  limit.bytes = limit.real;
  return problems;
};

const FIXED_SEEDS: Record<string, number> = {
  "Recent speech loses its speaker": 2,
  "Same-tick audio changes owners": 142,
};

const PAUSE_FIXED_SEEDS: Record<string, number> = {
  "No audio reaches a provider while captions are paused": 4,
};

const BURST_FIXED_SEEDS: Record<string, number> = {
  "Later audio gets dropped first": 1,
};

const EXTENDED_FIXED_SEEDS: Record<string, number> = {
  "Shown words are not saved": 45,
  "Early starts miss continuing speech": 8,
  "Switches can lose buffered speech": 12,
  "Corrupt audio escapes error checks": 4,
};

describe("caption chunks under random speech, signals and drops", () => {
  it.each(Object.entries(FIXED_SEEDS))("%s (seed %i)", async (_thread, seed) => {
    expect(await runOnce(seed)).toEqual([]);
  });

  it.each(Object.entries(EXTENDED_FIXED_SEEDS))("%s (extended seed %i)", async (_thread, seed) => {
    expect(await runOnce(seed, { extended: true })).toEqual([]);
  });

  it.each(Object.entries(PAUSE_FIXED_SEEDS))("%s (pause seed %i)", async (_thread, seed) => {
    expect(await runOnce(seed, { pauses: true })).toEqual([]);
  });

  it.each(Object.entries(BURST_FIXED_SEEDS))("%s (burst seed %i)", async (_thread, seed) => {
    expect(await runOnce(seed, { bursts: true })).toEqual([]);
  });

  it(`forwards no audio while captions are paused across ${PAUSE_RUNS} seeded runs`, async () => {
    const failures: string[] = [];
    const first = Number(process.env.TRANSCRIPT_CHUNK_ORDER_FROM ?? 1);
    const maxFailures = Number(process.env.TRANSCRIPT_CHUNK_ORDER_MAX_FAILURES ?? 3);
    for (let seed = first; seed < first + PAUSE_RUNS && failures.length < maxFailures; seed += 1) {
      const problems = await runOnce(seed, { pauses: true });
      if (problems.length > 0) failures.push(`seed ${seed}: ${problems.join(" | ")}`);
    }
    expect(failures).toEqual([]);
  }, Math.max(600_000, PAUSE_RUNS * 1_500));

  it(`drops the oldest audio first at the audio limit under same-millisecond bursts across ${BURST_RUNS} seeded runs`, async () => {
    const failures: string[] = [];
    const first = Number(process.env.TRANSCRIPT_CHUNK_ORDER_FROM ?? 1);
    const maxFailures = Number(process.env.TRANSCRIPT_CHUNK_ORDER_MAX_FAILURES ?? 3);
    for (let seed = first; seed < first + BURST_RUNS && failures.length < maxFailures; seed += 1) {
      const problems = await runOnce(seed, { bursts: true });
      if (problems.length > 0) failures.push(`seed ${seed}: ${problems.join(" | ")}`);
    }
    expect(failures).toEqual([]);
  }, Math.max(600_000, BURST_RUNS * 1_500));

  it(`keeps every chunk and every shown word through saves, switches, late reconnects and bad frames across ${EXTENDED_RUNS} seeded runs`, async () => {
    const failures: string[] = [];
    const first = Number(process.env.TRANSCRIPT_CHUNK_ORDER_FROM ?? 1);
    const maxFailures = Number(process.env.TRANSCRIPT_CHUNK_ORDER_MAX_FAILURES ?? 3);
    for (let seed = first; seed < first + EXTENDED_RUNS && failures.length < maxFailures; seed += 1) {
      const problems = await runOnce(seed, { extended: true });
      if (problems.length > 0) failures.push(`seed ${seed}: ${problems.join(" | ")}`);
    }
    expect(failures).toEqual([]);
  }, Math.max(600_000, EXTENDED_RUNS * 1_500));

  it(`lets a late answer fill the gap of a line that ended with another in the same millisecond, under a one to three line cap, across ${SMALL_CAP_RUNS} seeded runs`, async () => {
    const failures: string[] = [];
    const first = Number(process.env.TRANSCRIPT_CHUNK_ORDER_FROM ?? 1);
    const maxFailures = Number(process.env.TRANSCRIPT_CHUNK_ORDER_MAX_FAILURES ?? 3);
    for (let seed = first; seed < first + SMALL_CAP_RUNS && failures.length < maxFailures; seed += 1) {
      const problems = await runOnce(seed, { smallCap: true });
      if (problems.length > 0) failures.push(`seed ${seed}: ${problems.join(" | ")}`);
    }
    expect(failures).toEqual([]);
  }, Math.max(600_000, SMALL_CAP_RUNS * 1_500));

  it(`keeps every chunk with its sender, in send order, across ${RUNS} seeded runs`, async () => {
    const failures: string[] = [];
    const first = Number(process.env.TRANSCRIPT_CHUNK_ORDER_FROM ?? 1);
    const maxFailures = Number(process.env.TRANSCRIPT_CHUNK_ORDER_MAX_FAILURES ?? 3);
    for (let seed = first; seed < first + RUNS && failures.length < maxFailures; seed += 1) {
      const problems = await runOnce(seed);
      if (problems.length > 0) failures.push(`seed ${seed}: ${problems.join(" | ")}`);
    }
    expect(failures).toEqual([]);
  }, Math.max(600_000, RUNS * 1_000));
});
