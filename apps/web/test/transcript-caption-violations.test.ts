import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPTION_COMMIT_ACK_TIMEOUT_MS,
  TRANSCRIPTION_GAP_MARKER as GAP,
  TRANSCRIPTION_LINE_DEADLINE_MS as DEADLINE,
} from "../transcript-worker/src/constants";
import { Pcm24To16Downsampler } from "../transcript-worker/src/transcription/sarvam";
import { clicksPcm, pcmBase64, voicedPcm } from "./transcript-audio-fixtures";
import {
  OPENAI,
  SARVAM,
  openAiCommitted,
  sarvamFinal,
  sarvamSpeechStart,
  settle,
  transcriptRoomRig,
  type FakeProviderSocket,
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
type Speaker = { userId: string; displayName: string };
const ada = { userId: "ada", displayName: "Ada" };
const grace = { userId: "grace", displayName: "Grace" };
const lin = { userId: "lin", displayName: "Lin" };

const named = (pitch: number) => pcmBase64(voicedPcm(-26, 200, pitch));
const whisper = pcmBase64(voicedPcm(-56, 200, 180));
const shown = (rig: Rig) =>
  rig.viewerTranscript().segments.map(({ text, speakerUserId }) => [text, speakerUserId] as const);
const laneOf = async (rig: Rig, speaker: Speaker): Promise<FakeProviderSocket> => {
  const withLanes = rig as Rig & { lane?: (speaker: Speaker) => Promise<FakeProviderSocket> };
  if (withLanes.lane) return withLanes.lane(speaker);
  await settle();
  return rig.providerSockets().at(-1)!;
};
const startRig = async (model: string) => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  const rig = await transcriptRoomRig(lookup, model);
  await rig.start(model === OPENAI ? "en" : "hi");
  return rig;
};
const sendNamed = (rig: Rig, audio: string, speaker: Speaker) =>
  rig.send({ type: "audio.chunk", audio, speaker });

describe("one row per violation in the caption ownership design read", () => {
  it("V2: audio held through a paused reconnect reaches the provider before newer audio once a takeover resumes captions (pause seed 2808)", async () => {
    const rig = await startRig(OPENAI);
    const held = named(150);
    const later = [named(210), named(240)];
    const [first] = rig.providerSockets();
    rig.connectPlans.push({ lateMs: 2_000 });
    first.disconnect();
    await settle();
    await sendNamed(rig, held, grace);
    await rig.send({ type: "session.pause" });
    await vi.advanceTimersByTimeAsync(3_000);
    rig.connectPlans.push({ lateMs: 5_000 });
    void rig.switchTo("ta");
    await settle();
    for (const audio of later) await sendNamed(rig, audio, lin);
    await settle();

    const order = rig
      .providerSockets()
      .flatMap((socket) => socket.sent)
      .flatMap((message) => {
        const audio = message.audio;
        return audio === held ? ["grace held"] : later.includes(String(audio)) ? ["lin"] : [];
      });
    expect(order).toEqual(["grace held", "lin", "lin"]);
  });

  it("V1: a Sarvam answer that comes after its utterance timed out, with nobody else waiting, never lands on a newer speaker", async () => {
    const rig = await startRig(SARVAM);
    const [first] = rig.providerSockets();
    await rig.speak(grace);
    first.emit(sarvamSpeechStart());
    await rig.endTurn(grace);
    await vi.advanceTimersByTimeAsync(DEADLINE + 1_000);
    await rig.speak(lin);
    const linLane = await laneOf(rig, lin);
    linLane.emit(sarvamSpeechStart());
    await rig.endTurn(lin);
    await vi.advanceTimersByTimeAsync(1_000);
    first.emit(sarvamFinal("grace-late", "Grace late."));
    linLane.emit(sarvamFinal("lin", "Lin words."));
    await settle();

    expect(shown(rig).filter(([text]) => text === "Grace late.")).toEqual([]);
    expect(shown(rig).find(([text]) => text === "Lin words.")?.[1] ?? "lin").toBe("lin");
  });

  it("V3: quiet speech our check misses never takes the words of another speaker who talks right after it", async () => {
    const rig = await startRig(SARVAM);
    const [first] = rig.providerSockets();
    await rig.speak(ada);
    first.emit(sarvamSpeechStart());
    await rig.endTurn(ada);
    first.emit(sarvamFinal("setup", "Setup."));
    await vi.advanceTimersByTimeAsync(2_000);

    await sendNamed(rig, whisper, lin);
    await vi.advanceTimersByTimeAsync(200);
    await rig.speak(grace);
    (await laneOf(rig, lin)).emit(sarvamSpeechStart());
    (await laneOf(rig, grace)).emit(sarvamSpeechStart());
    await rig.endTurn(grace);
    (await laneOf(rig, lin)).emit(sarvamFinal("lin", "Lin whispered."));
    (await laneOf(rig, grace)).emit(sarvamFinal("grace", "Grace spoke."));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);

    const lines = shown(rig);
    expect(lines.filter(([text, speaker]) => text === "Lin whispered." && speaker !== "lin")).toEqual([]);
    expect(lines.filter(([text, speaker]) => text === "Grace spoke." && speaker !== "grace")).toEqual([]);
  });

  it("V6: an OpenAI acknowledgment for audio the room never committed shows nothing", async () => {
    const rig = await startRig(OPENAI);
    const [socket] = rig.providerSockets();
    socket.emit(openAiCommitted("stray"));
    socket.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "stray", transcript: "Nobody said this." });
    await settle();

    expect(shown(rig)).toEqual([]);
  });

  it("V8: a relay clear with no commit ends the Sarvam turn on the wire", async () => {
    const rig = await startRig(SARVAM);
    await rig.speak(ada);
    const socket = await laneOf(rig, ada);
    const before = socket.sentTypes().filter((type) => type === "flush").length;
    await rig.clear(ada);
    await settle();

    expect(socket.sentTypes().filter((type) => type === "flush").length).toBe(before + 1);
  });

  it("V10: a save that fails just before notes stop is never retried into a snapshot after the stop", async () => {
    const rig = await startRig(OPENAI);
    let failures = 1;
    rig.saves.before = async () => {
      if (failures <= 0) return;
      failures -= 1;
      throw new Error("Snapshot write failed (injected).");
    };
    await rig.speak(ada);
    await rig.commit(ada);
    await settle();
    const written = rig.snapshotCount();
    await rig.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(rig.snapshotCount()).toBe(written);
  });

  it("V11: an owed line with no audio left ends at the drop instead of waiting forever for a replay", async () => {
    const rig = await startRig(SARVAM);
    const [socket] = rig.providerSockets();
    await rig.speak(ada);
    socket.emit(sarvamSpeechStart());
    await rig.endTurn(ada);
    await vi.advanceTimersByTimeAsync(200);
    socket.emit(sarvamSpeechStart());
    await settle();
    socket.disconnect();
    await settle();

    const waiting = (rig.room as unknown as { ledger: { all(): { state: string; heard: boolean }[] } }).ledger
      .all()
      .filter(({ state, heard }) => !heard && ["pending_ack", "open", "replaying"].includes(state));
    expect(waiting).toEqual([]);
  });

  it("Lanes: two speakers who talk over each other each keep their own words, whatever order Sarvam answers in", async () => {
    const rig = await startRig(SARVAM);
    const [first] = rig.providerSockets();
    await rig.speak(ada);
    first.emit(sarvamSpeechStart());
    await rig.endTurn(ada);
    first.emit(sarvamFinal("setup", "Setup."));
    await vi.advanceTimersByTimeAsync(3_000);

    await rig.speak(ada);
    await rig.speak(grace);
    await rig.speak(ada);
    await rig.speak(grace);
    const adaLane = await laneOf(rig, ada);
    const graceLane = await laneOf(rig, grace);
    graceLane.emit(sarvamSpeechStart());
    adaLane.emit(sarvamSpeechStart());
    graceLane.emit(sarvamFinal("g", "Grace over Ada."));
    adaLane.emit(sarvamFinal("a", "Ada over Grace."));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);

    const lines = shown(rig);
    expect(lines.find(([text]) => text === "Grace over Ada.")?.[1]).toBe("grace");
    expect(lines.find(([text]) => text === "Ada over Grace.")?.[1]).toBe("ada");
  });

  it("Lanes: each speaker's Sarvam audio goes only to that speaker's connection", async () => {
    const rig = await startRig(SARVAM);
    const adaAudio = named(130);
    const graceAudio = named(260);
    await sendNamed(rig, adaAudio, ada);
    await sendNamed(rig, graceAudio, grace);
    await settle();
    const down = (audio: string) => new Pcm24To16Downsampler().downsample(audio);
    const carries = (socket: FakeProviderSocket, audio: string) =>
      socket.sent.some((message) => (message.audio as { data?: string } | undefined)?.data === down(audio));

    const adaLane = await laneOf(rig, ada);
    const graceLane = await laneOf(rig, grace);
    expect([carries(adaLane, adaAudio), carries(adaLane, graceAudio)]).toEqual([true, false]);
    expect([carries(graceLane, adaAudio), carries(graceLane, graceAudio)]).toEqual([false, true]);
  });
});

const mo = { userId: "mo", displayName: "Mo" };
const kit = { userId: "kit", displayName: "Kit" };
const clicks = pcmBase64(clicksPcm(-12, 200, 5));
const openSockets = (rig: Rig) => rig.providerSockets().filter(({ closed }) => !closed);
const carriesAudio = (socket: FakeProviderSocket, audio: string) => {
  const wire = new Pcm24To16Downsampler().downsample(audio);
  return socket.sent.some((message) => (message.audio as { data?: string } | undefined)?.data === wire);
};
const answerTurn = async (rig: Rig, speaker: Speaker, requestId: string, text: string) => {
  const socket = await laneOf(rig, speaker);
  socket.emit(sarvamSpeechStart());
  socket.emit(sarvamFinal(requestId, text));
};
const signalOnce = async (rig: Rig) => {
  await sendNamed(rig, named(140), ada);
  await answerTurn(rig, ada, "setup", "Setup.");
  await rig.clear(ada);
  await vi.advanceTimersByTimeAsync(3_000);
};

describe("each Sarvam lane owns its own turns and answers", () => {
  it("an utterance Sarvam never answers shows its gap at its own audio, never at quiet audio our check counted before it (residual seed 11)", async () => {
    const rig = await startRig(SARVAM);
    await signalOnce(rig);
    await sendNamed(rig, clicks, lin);
    await rig.clear(lin);
    await vi.advanceTimersByTimeAsync(400);
    const spokeAt = Date.now();
    await sendNamed(rig, named(170), lin);
    await rig.clear(lin);
    await vi.advanceTimersByTimeAsync(3_000);
    (await laneOf(rig, lin)).emit(sarvamSpeechStart());
    await vi.advanceTimersByTimeAsync(DEADLINE + 5_000);

    const gaps = rig.viewerTranscript().segments.filter(({ text, speakerUserId }) => text === GAP && speakerUserId === "lin");
    expect(gaps.map(({ startMs }) => startMs >= spokeAt)).toEqual([true]);
  });

  it("when Sarvam answers one turn in two parts, the second part stays on that turn's line and never takes the speaker's next turn", async () => {
    const rig = await startRig(SARVAM);
    await signalOnce(rig);
    await sendNamed(rig, named(150), ada);
    await sendNamed(rig, named(152), ada);
    await rig.clear(ada);
    await vi.advanceTimersByTimeAsync(100);
    await answerTurn(rig, ada, "p1", "Part one.");
    await vi.advanceTimersByTimeAsync(100);
    await sendNamed(rig, named(210), ada);
    await rig.clear(ada);
    await vi.advanceTimersByTimeAsync(1_300);
    await answerTurn(rig, ada, "p2", "Part two.");
    await vi.advanceTimersByTimeAsync(1_600);
    await answerTurn(rig, ada, "p3", "Next turn.");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(shown(rig).filter(([, speaker]) => speaker === "ada").map(([text]) => text)).toEqual([
      "Setup.",
      "Part one. Part two.",
      "Next turn.",
    ]);
  });

  it("a clear from one speaker never splits another speaker's turn, so a reconnect replays none of that speaker's answered audio as a new line (Greptile r4688831704)", async () => {
    const rig = await startRig(SARVAM);
    await sendNamed(rig, named(150), ada);
    await rig.clear(grace);
    await sendNamed(rig, named(160), ada);
    await answerTurn(rig, ada, "a", "Ada said both.");
    await rig.clear(ada);
    await vi.advanceTimersByTimeAsync(2_000);
    (await laneOf(rig, ada)).disconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    await answerTurn(rig, ada, "again", "Ada said both.");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(shown(rig).filter(([text]) => text === "Ada said both.")).toEqual([["Ada said both.", "ada"]]);
  });

  it("speech under our voice threshold keeps Sarvam's words when a second START comes over three seconds later (Greptile r4688831705)", async () => {
    const rig = await startRig(SARVAM);
    const [first] = rig.providerSockets();
    await sendNamed(rig, whisper, ada);
    first.emit(sarvamSpeechStart());
    await vi.advanceTimersByTimeAsync(3_200);
    await sendNamed(rig, pcmBase64(voicedPcm(-56, 200, 190)), ada);
    first.emit(sarvamSpeechStart());
    first.emit(sarvamFinal("w1", "Whispered first."));
    await rig.clear(ada);
    await vi.advanceTimersByTimeAsync(DEADLINE + 1_000);

    expect(shown(rig)).toEqual([[`Whispered first. ${GAP}`, "ada"]]);
  });

  it("with one saved segment, quiet utterances keep their speaking order (Greptile r4688831713)", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const rig = await transcriptRoomRig(lookup, SARVAM, { TRANSCRIPT_MAX_SEGMENTS: "1" });
    await rig.start("hi");
    for (const [index, text] of ["First quiet.", "Second quiet.", "Third quiet."].entries()) {
      await sendNamed(rig, pcmBase64(voicedPcm(-56, 200, 170 + index * 9)), ada);
      await answerTurn(rig, ada, `q${index}`, text);
      await rig.clear(ada);
      await vi.advanceTimersByTimeAsync(3_000);
    }

    const places = rig.broadcastPlacesByWords();
    expect(Math.max(...(places.get("Second") ?? [])) < Math.min(...(places.get("Third") ?? []))).toBe(true);
  });

  it("an idle speaker's connection closes once their last answer is in, and their next audio opens a new one (Greptile r4688831726)", async () => {
    const rig = await startRig(SARVAM);
    await signalOnce(rig);
    await sendNamed(rig, named(200), grace);
    const graceLane = await laneOf(rig, grace);
    await answerTurn(rig, grace, "g1", "Grace before.");
    await rig.clear(grace);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(graceLane.closed).toBe(true);

    const again = named(230);
    await sendNamed(rig, again, grace);
    await settle();
    const reopened = await laneOf(rig, grace);
    await answerTurn(rig, grace, "g2", "Grace after.");
    await rig.clear(grace);
    await vi.advanceTimersByTimeAsync(3_000);

    expect([reopened === graceLane, carriesAudio(reopened, again)]).toEqual([false, true]);
    expect(shown(rig).filter(([, speaker]) => speaker === "grace")).toEqual([
      ["Grace before.", "grace"],
      ["Grace after.", "grace"],
    ]);
  });

  it("a stopped screen share's connection closes while the same person's microphone keeps its own", async () => {
    const rig = await startRig(SARVAM);
    const mic = { ...ada, source: "local" as const };
    const screen = { ...ada, source: "screen" as const };
    await rig.speak(mic);
    await rig.speak(screen);
    const screenLane = await laneOf(rig, screen);
    await answerTurn(rig, screen, "s", "Shared clip.");
    await rig.clear(screen);
    for (let step = 0; step < 9; step += 1) {
      await vi.advanceTimersByTimeAsync(2_000);
      await answerTurn(rig, mic, `m${step}`, `Mic ${step}.`);
      await rig.clear(mic);
      await vi.advanceTimersByTimeAsync(3_000);
      await rig.speak(mic);
    }

    expect([screenLane.closed, (await laneOf(rig, mic)).closed, rig.providerSockets().length]).toEqual([true, false, 2]);
  });

  it("at most four speakers hold a Sarvam connection at once; a fifth waits for a free one and still gets only its own words", async () => {
    const rig = await startRig(SARVAM);
    await signalOnce(rig);
    const audioOf = new Map<Speaker, string>();
    for (const [index, person] of [ada, grace, lin, mo].entries()) {
      audioOf.set(person, named(150 + index * 30));
      await sendNamed(rig, audioOf.get(person)!, person);
    }
    await settle();
    const kitAudio = named(290);
    await sendNamed(rig, kitAudio, kit);
    await settle();
    const whileFull = openSockets(rig).length;
    const kitWaited = !openSockets(rig).some((socket) => carriesAudio(socket, kitAudio));

    await answerTurn(rig, ada, "a", "Ada first.");
    await rig.clear(ada);
    await vi.advanceTimersByTimeAsync(3_000);
    const kitLane = openSockets(rig).find((socket) => carriesAudio(socket, kitAudio));
    kitLane?.emit(sarvamSpeechStart());
    kitLane?.emit(sarvamFinal("k", "Kit words."));
    await rig.clear(kit);
    await vi.advanceTimersByTimeAsync(3_000);

    expect([whileFull, kitWaited, openSockets(rig).length <= 4]).toEqual([4, true, true]);
    expect(shown(rig).filter(([text]) => text !== "Setup.")).toEqual([
      ["Ada first.", "ada"],
      ["Kit words.", "kit"],
    ]);
  });

  it("a heard turn whose first START_SPEECH comes seconds after the turn ended keeps a caption or a gap, never nothing (Greptile r4689037540)", async () => {
    const rig = await startRig(SARVAM);
    const [first] = rig.providerSockets();
    await rig.speak(ada);
    await rig.clear(ada);
    await vi.advanceTimersByTimeAsync(4_000);
    first.emit(sarvamSpeechStart());
    await vi.advanceTimersByTimeAsync(DEADLINE + 5_000);

    expect(shown(rig)).toEqual([[GAP, "ada"]]);
  });

  it("a turn whose answer is late moves the speaker's next turn to a fresh connection, and the late answer still lands on its own turn", async () => {
    const rig = await startRig(SARVAM);
    await signalOnce(rig);
    await sendNamed(rig, named(200), grace);
    const slow = await laneOf(rig, grace);
    slow.emit(sarvamSpeechStart());
    await rig.clear(grace);
    await vi.advanceTimersByTimeAsync(6_000);
    const next = named(240);
    await sendNamed(rig, next, grace);
    await settle();
    const fresh = await laneOf(rig, grace);
    fresh.emit(sarvamSpeechStart());
    fresh.emit(sarvamFinal("g2", "Grace second."));
    await rig.clear(grace);
    slow.emit(sarvamFinal("g1", "Grace first."));
    await vi.advanceTimersByTimeAsync(3_000);

    expect([fresh === slow, carriesAudio(fresh, next), carriesAudio(slow, next), slow.closed]).toEqual([false, true, false, true]);
    expect(shown(rig).filter(([, speaker]) => speaker === "grace")).toEqual([
      ["Grace first.", "grace"],
      ["Grace second.", "grace"],
    ]);
  });

  it("a whisper Sarvam transcribed is replayed after a reconnect and waits for its own answer, so the speaker's next turn never takes it (oracle seed 1723)", async () => {
    const rig = await startRig(SARVAM);
    const [first] = rig.providerSockets();
    await sendNamed(rig, whisper, ada);
    await rig.clear(ada);
    first.emit(sarvamSpeechStart());
    first.emit(sarvamFinal("w", "Whisper words."));
    await vi.advanceTimersByTimeAsync(1_000);
    first.disconnect();
    await settle();
    const replacement = await laneOf(rig, ada);
    await vi.advanceTimersByTimeAsync(3_000);
    await sendNamed(rig, named(180), ada);
    await rig.clear(ada);
    replacement.emit(sarvamSpeechStart());
    replacement.emit(sarvamFinal("w2", "Whisper words."));
    await vi.advanceTimersByTimeAsync(3_000);
    replacement.emit(sarvamSpeechStart());
    replacement.emit(sarvamFinal("n", "Next words."));
    await vi.advanceTimersByTimeAsync(3_000);

    expect(shown(rig)).toEqual([
      ["Whisper words.", "ada"],
      ["Next words.", "ada"],
    ]);
  });

  it("speech that joins a replayed line across a second failed reconnect still shows a gap when nothing answers it (oracle seed 722)", async () => {
    const rig = await startRig(OPENAI);
    const [first] = rig.providerSockets();
    await rig.sendAudio("silence", ada);
    rig.connectPlans.push("unreachable", 1);
    first.disconnect();
    await settle();
    await rig.speak(ada);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_COMMIT_ACK_TIMEOUT_MS + 1_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(shown(rig).filter(([, speaker]) => speaker === "ada")).toEqual([[GAP, "ada"]]);
  });

  it("a long outage with repeated commits and clears holds one boundary per speaker, not one per message (Greptile r4688831730)", async () => {
    const rig = await startRig(SARVAM);
    await rig.speak(ada);
    rig.connectPlans.push({ lateMs: 30_000 });
    rig.providerSockets()[0].disconnect();
    await settle();
    for (let step = 0; step < 150; step += 1) {
      await rig.commit(ada);
      await rig.clear(ada);
      await rig.clear(grace);
      await vi.advanceTimersByTimeAsync(100);
    }
    const held = (rig.room as unknown as { audio: { queuedEvents(): unknown[] } }).audio.queuedEvents().length;

    expect(held).toBeLessThanOrEqual(2);
  });
});

describe("the gap is the accepted cost, never another speaker", () => {
  it("a Sarvam utterance that never gets its answer shows as a gap under its own speaker", async () => {
    const rig = await startRig(SARVAM);
    const [first] = rig.providerSockets();
    await rig.speak(grace);
    first.emit(sarvamSpeechStart());
    await rig.endTurn(grace);
    await vi.advanceTimersByTimeAsync(DEADLINE + 1_000);

    expect(shown(rig)).toEqual([[GAP, "grace"]]);
  });
});
