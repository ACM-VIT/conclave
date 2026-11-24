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

const RUNS = Number(process.env.TRANSCRIPT_CHUNK_ORDER_RUNS ?? 300);
const EXTENDED_RUNS = Number(process.env.TRANSCRIPT_CHUNK_ORDER_EXTENDED_RUNS ?? 300);
const MALFORMED = ["%%%%", "@@@@AAAA", "A", "====", "AB=C", "\u0000\u0001"];
const LANGUAGES = ["ta", "hi", "bn"];
const SAVE_FAILURE = "Snapshot write failed (injected).";
const STEPS = 40;
const POOL = 400;

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
  place: { sequence: number };
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
  transcriptionRecoveryAudio: { chunks(): HeldChunk[] };
  segments: { itemId: string; text: string }[];
  state: { storage: { put: (key: string, value: unknown) => Promise<void> } };
};

const audioCount = (socket: FakeProviderSocket) =>
  socket.sent.filter((message) => {
    const audio = (message as { audio?: unknown }).audio;
    return typeof audio === "string" || Boolean((audio as { data?: string } | undefined)?.data);
  }).length;

const runOnce = async (seed: number, extended = false): Promise<string[]> => {
  const random = randomFrom(seed);
  const problems: string[] = [];
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  const openai = extended && seed % 3 === 0;
  const rig = await transcriptRoomRig(lookup, openai ? OPENAI : SARVAM);
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
  const shown = new Set<string>();
  const roomTurn = new Map<string, number>();
  const runOf = new Map<number, number>();
  const removed = new Set<string>();
  const ledger = room.ledger;
  const end = ledger.end.bind(ledger);
  ledger.end = (line, ...rest) => {
    for (const chunk of line.audio) shown.add(chunk.audio);
    end(line, ...rest);
  };
  const remove = ledger.remove.bind(ledger);
  ledger.remove = (id) => {
    const line = ledger.get(id);
    const ended = line && (line.state === "final" || line.state === "gap" || line.state === "dropped");
    for (const chunk of line?.audio ?? []) (ended ? shown : removed).add(chunk.audio);
    remove(id);
  };
  let speaker = speakers[0];
  let turn = 0;
  let run = 0;
  let previousSpeaker = "";
  const saveMode = { delayMs: 0, fail: false };
  let savesInFlight = 0;
  let lastSaveFailed = false;
  let savedForms = new Map<string, string>();
  const delivered = new Set<string>();
  const audioAtSwitch = new Map<FakeProviderSocket, number>();
  let switchFloor = -1;
  const switches: Promise<unknown>[] = [];
  if (extended) {
    const put = room.state.storage.put.bind(room.state.storage);
    room.state.storage.put = async (key, value) => {
      const segments = (value as { segments?: { itemId: string; text: string }[] }).segments ?? [];
      const forms = new Map(segments.map(({ itemId, text }) => [itemId, text === GAP ? "gap" : "words"]));
      savesInFlight += 1;
      try {
        if (saveMode.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, saveMode.delayMs));
        if (saveMode.fail) throw new Error(SAVE_FAILURE);
        await put(key, value);
        savedForms = forms;
        lastSaveFailed = false;
      } catch (error) {
        lastSaveFailed = true;
        throw error;
      } finally {
        savesInFlight -= 1;
      }
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

  const check = (stage: string) => {
    const now = Date.now();
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
        if (ended) shown.add(chunk.audio);
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
          (other) => other.index > first && other.index < last && other.speaker !== line.speaker.userId,
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
    if (extended && savesInFlight === 0 && !lastSaveFailed) {
      for (const line of room.ledger.activeUnordered()) {
        if (line.text.trim() !== "" && savedForms.get(line.id) !== "words") {
          report(`${stage}: line ${line.id} shows words that were never saved`);
        }
      }
    }
    if (switchFloor >= 0) {
      for (const providerSocket of rig.providerSockets()) {
        if (providerSocket.requestIndex >= switchFloor) continue;
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
    const activeLines = new Set(room.ledger.activeUnordered().map(({ id }) => `line ${id}`));
    for (const [audio, holder] of lastHolder) {
      if (holders.has(audio) || shown.has(audio)) continue;
      const info = sent.get(audio)!;
      if (!info.voiced) continue;
      if (removed.has(audio)) {
        report(`${stage}: ${describeChunk(info)} dropped with its line`);
        continue;
      }
      if (holder.startsWith("line ") && !activeLines.has(holder)) continue;
      if (delivered.has(audio)) continue;
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
    if (index >= POOL) return;
    if (speaker.userId !== previousSpeaker) {
      run += 1;
      previousSpeaker = speaker.userId;
    }
    const audio = (voiced ? VOICED : QUIET)[index];
    const info = { index, speaker: speaker.userId, voiced, at: Date.now(), turn, run };
    sent.set(audio, info);
    order.push(info);
    await tolerate(() => rig.send({ type: "audio.chunk", audio, speaker }), `chunk #${index}`);
  };

  const extendedEvent = async (step: number) => {
    const pick = random();
    if (pick < 0.18) {
      saveMode.delayMs = random() < 0.5 ? 0 : Math.floor(random() * 2_500);
      saveMode.fail = random() < 0.3;
    } else if (pick < 0.36) {
      for (const [audio, holder] of lastHolder) if (holder !== "buffered") delivered.add(audio);
      switchFloor = rig.providerRequestCount();
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
      await sendChunk(true);
      latestSocket().emit(sarvamSpeechStart());
      latestSocket().emit(sarvamFinal(`s${step}`, `Short ${step}.`));
      latestSocket().emit(sarvamSpeechStart());
      const more = 1 + Math.floor(random() * 3);
      const continuing: string[] = [];
      for (let chunk = 0; chunk < more; chunk += 1) {
        await vi.advanceTimersByTimeAsync(80 + Math.floor(random() * 120));
        await sendChunk(true);
        continuing.push(VOICED[order.length - 1]);
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
  await vi.advanceTimersByTimeAsync(DEADLINE + 1_000);
  await Promise.all(switches);
  await vi.advanceTimersByTimeAsync(DEADLINE + 1_000);
  check("end");
  vi.useRealTimers();
  return problems;
};

const FIXED_SEEDS: Record<string, number> = {
  "Recent speech loses its speaker": 2,
  "Same-tick audio changes owners": 142,
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
    expect(await runOnce(seed, true)).toEqual([]);
  });

  it(`keeps every chunk and every shown word through saves, switches, late reconnects and bad frames across ${EXTENDED_RUNS} seeded runs`, async () => {
    const failures: string[] = [];
    const first = Number(process.env.TRANSCRIPT_CHUNK_ORDER_FROM ?? 1);
    const maxFailures = Number(process.env.TRANSCRIPT_CHUNK_ORDER_MAX_FAILURES ?? 3);
    for (let seed = first; seed < first + EXTENDED_RUNS && failures.length < maxFailures; seed += 1) {
      const problems = await runOnce(seed, true);
      if (problems.length > 0) failures.push(`seed ${seed}: ${problems.join(" | ")}`);
    }
    expect(failures).toEqual([]);
  }, Math.max(600_000, EXTENDED_RUNS * 1_500));

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
