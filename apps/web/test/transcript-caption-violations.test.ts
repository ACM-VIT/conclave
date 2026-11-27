import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPTION_COMMIT_ACK_TIMEOUT_MS,
  TRANSCRIPTION_GAP_MARKER as GAP,
  TRANSCRIPTION_LINE_DEADLINE_MS as DEADLINE,
} from "../transcript-worker/src/constants";
import { Pcm24To16Downsampler } from "../transcript-worker/src/transcription/sarvam";
import { clicksPcm, noisePcm, pcmBase64, voicedPcm } from "./transcript-audio-fixtures";
import {
  OPENAI,
  SARVAM,
  openAiCommitted,
  sarvamFinal,
  sarvamSpeechEnd,
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
    const parted = await laneOf(rig, ada);
    await rig.clear(ada);
    await vi.advanceTimersByTimeAsync(100);
    await answerTurn(rig, ada, "p1", "Part one.");
    await vi.advanceTimersByTimeAsync(100);
    await sendNamed(rig, named(210), ada);
    await rig.clear(ada);
    await vi.advanceTimersByTimeAsync(1_300);
    parted.emit(sarvamSpeechStart());
    parted.emit(sarvamFinal("p2", "Part two."));
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
    const adaFirst = named(150);
    const adaSecond = named(160);
    await sendNamed(rig, adaFirst, ada);
    await rig.clear(grace);
    await sendNamed(rig, adaSecond, ada);
    await answerTurn(rig, ada, "a", "Ada said both.");
    await rig.clear(ada);
    await vi.advanceTimersByTimeAsync(2_000);
    const lane = await laneOf(rig, ada);
    lane.disconnect();
    await vi.advanceTimersByTimeAsync(4_000);

    const resent = rig.providerSockets().filter((socket) => socket !== lane && (carriesAudio(socket, adaFirst) || carriesAudio(socket, adaSecond)));
    expect([shown(rig), resent]).toEqual([[["Ada said both.", "ada"]], []]);
  });

  it("speech under our voice threshold keeps Sarvam's words when a second START comes over three seconds later (Greptile r4688831705)", async () => {
    const rig = await startRig(SARVAM);
    const [first] = rig.providerSockets();
    await sendNamed(rig, whisper, ada);
    first.emit(sarvamSpeechStart());
    await vi.advanceTimersByTimeAsync(1_000);
    await sendNamed(rig, pcmBase64(voicedPcm(-56, 200, 190)), ada);
    first.emit(sarvamSpeechEnd());
    await rig.clear(ada);
    await vi.advanceTimersByTimeAsync(3_200);
    first.emit(sarvamSpeechStart());
    first.emit(sarvamFinal("w1", "Whispered first."));
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

    expect([screenLane.closed, (await laneOf(rig, mic)).closed, openSockets(rig).length <= 4]).toEqual([true, false, true]);
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

    expect([fresh === slow, carriesAudio(fresh, next), carriesAudio(slow, next)]).toEqual([false, true, false]);
    expect(shown(rig).filter(([, speaker]) => speaker === "grace")).toEqual([
      ["Grace first.", "grace"],
      ["Grace second.", "grace"],
    ]);
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect(slow.closed).toBe(true);
  });

  it("a whisper Sarvam already answered keeps its words across a reconnect and is never replayed into the speaker's next turn (oracle seed 1723)", async () => {
    const rig = await startRig(SARVAM);
    const [first] = rig.providerSockets();
    await sendNamed(rig, whisper, ada);
    await rig.clear(ada);
    first.emit(sarvamSpeechStart());
    first.emit(sarvamFinal("w", "Whisper words."));
    await vi.advanceTimersByTimeAsync(1_000);
    first.disconnect();
    await vi.advanceTimersByTimeAsync(3_000);
    await sendNamed(rig, named(180), ada);
    await rig.clear(ada);
    const replacement = await laneOf(rig, ada);
    replacement.emit(sarvamSpeechStart());
    replacement.emit(sarvamFinal("n", "Next words."));
    await vi.advanceTimersByTimeAsync(3_000);

    expect(carriesAudio(replacement, whisper)).toBe(false);
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

  it("a partly answered turn keeps the words viewers saw across a reconnect, even when a replacement answers only part of it (oracle seed 3035)", async () => {
    const rig = await startRig(SARVAM);
    const [first] = rig.providerSockets();
    await sendNamed(rig, named(150), lin);
    first.emit(sarvamFinal("one", "One."));
    await vi.advanceTimersByTimeAsync(700);
    await sendNamed(rig, named(190), lin);
    first.emit(sarvamFinal("two", "Two."));
    await settle();
    first.disconnect();
    await settle();
    const replacement = rig.providerSockets().at(-1)!;
    replacement.emit(sarvamFinal("again", "One."));
    await vi.advanceTimersByTimeAsync(DEADLINE + 1_000);

    expect(shown(rig)).toEqual([[`One. Two. ${GAP}`, "lin"]]);
  });

  it("two answers Sarvam sends moments apart for one turn, after its settle, stay on that turn", async () => {
    const rig = await startRig(SARVAM);
    const [first] = rig.providerSockets();
    await sendNamed(rig, named(150), ada);
    await rig.clear(ada);
    await vi.advanceTimersByTimeAsync(3_000);
    await sendNamed(rig, named(210), ada);
    const second = await laneOf(rig, ada);
    await rig.clear(ada);
    first.emit(sarvamFinal("a1", "Part one."));
    await vi.advanceTimersByTimeAsync(100);
    first.emit(sarvamFinal("a2", "Part two."));
    await vi.advanceTimersByTimeAsync(1_000);
    second.emit(sarvamFinal("b", "Next."));
    await vi.advanceTimersByTimeAsync(3_000);

    expect(shown(rig)).toEqual([
      ["Part one. Part two.", "ada"],
      ["Next.", "ada"],
    ]);
  });

  it("a heard turn whose only answer was empty still shows the late answer its own connection sends after it", async () => {
    const rig = await startRig(SARVAM);
    const [first] = rig.providerSockets();
    await sendNamed(rig, named(150), ada);
    await rig.clear(ada);
    first.emit(sarvamSpeechStart());
    first.emit(sarvamFinal("empty", ""));
    await vi.advanceTimersByTimeAsync(3_000);
    first.emit(sarvamSpeechStart());
    first.emit(sarvamFinal("late", "Late words."));
    await vi.advanceTimersByTimeAsync(3_000);

    expect(shown(rig)).toEqual([["Late words.", "ada"]]);
  });

  it("a noise turn still open at a reconnect is let go, never replayed", async () => {
    const rig = await startRig(SARVAM);
    const [first] = rig.providerSockets();
    const noise = pcmBase64(noisePcm(-60, 200, 3));
    await sendNamed(rig, noise, ada);
    first.disconnect();
    await vi.advanceTimersByTimeAsync(3_000);

    expect([carriesAudio(first, noise), rig.providerSockets().slice(1).some((socket) => carriesAudio(socket, noise))]).toEqual([true, false]);
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

describe("every Sarvam timer and limit has one owner", () => {
  it("a language switch drains each turn on its own deadline, so one speaker's timeout never cuts off another's answer (Greptile r4689923380)", async () => {
    const rig = await startRig(SARVAM);
    await sendNamed(rig, named(150), ada);
    (await laneOf(rig, ada)).emit(sarvamSpeechStart());
    await vi.advanceTimersByTimeAsync(25_000);
    await sendNamed(rig, named(200), grace);
    await rig.clear(grace);
    const graceLane = await laneOf(rig, grace);
    graceLane.emit(sarvamSpeechStart());
    await rig.switchTo("ta");
    await vi.advanceTimersByTimeAsync(10_000);
    graceLane.emit(sarvamFinal("g", "Grace in time."));
    await vi.advanceTimersByTimeAsync(3_000);

    const gapsShownUnderGrace = rig
      .sentMessages()
      .filter((message) => message.type === "segment.final" && message.segment.speakerUserId === "grace" && message.segment.text === GAP);
    expect(shown(rig)).toEqual([
      [GAP, "ada"],
      ["Grace in time.", "grace"],
    ]);
    expect(gapsShownUnderGrace).toEqual([]);
  });

  it("a quiet turn keeps its caption when Sarvam's first speech signal and answer come seconds after the turn ended (Greptile r4689923385)", async () => {
    const rig = await startRig(SARVAM);
    const [first] = rig.providerSockets();
    await sendNamed(rig, whisper, ada);
    await rig.clear(ada);
    await vi.advanceTimersByTimeAsync(4_000);
    first.emit(sarvamSpeechStart());
    first.emit(sarvamFinal("q", "Quiet words."));
    await vi.advanceTimersByTimeAsync(3_000);

    expect(shown(rig)).toEqual([["Quiet words.", "ada"]]);
  });

  it("a language switch keeps the whole room within four Sarvam sockets, and the new connection waits for the old one to free them (Greptile r4689923391)", async () => {
    const rig = await startRig(SARVAM);
    const people = [ada, grace, lin, mo];
    const oldLanes: FakeProviderSocket[] = [];
    for (const [index, person] of people.entries()) {
      await sendNamed(rig, named(150 + index * 30), person);
      await rig.clear(person);
      const lane = await laneOf(rig, person);
      lane.emit(sarvamSpeechStart());
      oldLanes.push(lane);
    }
    let most = openSockets(rig).length;
    const watch = () => {
      most = Math.max(most, openSockets(rig).length);
    };
    void rig.switchTo("ta");
    await settle();
    watch();
    const kitAudio = named(300);
    await sendNamed(rig, kitAudio, kit);
    await rig.clear(kit);
    await settle();
    watch();
    for (const [index, lane] of oldLanes.entries()) {
      lane.emit(sarvamFinal(`old${index}`, `Old ${index}.`));
      await vi.advanceTimersByTimeAsync(3_000);
      watch();
    }
    const kitLane = openSockets(rig).find((socket) => carriesAudio(socket, kitAudio));
    kitLane?.emit(sarvamSpeechStart());
    kitLane?.emit(sarvamFinal("k", "Kit after the switch."));
    await vi.advanceTimersByTimeAsync(3_000);
    watch();

    expect(most).toBeLessThanOrEqual(4);
    expect(shown(rig).filter(([, speaker]) => speaker === "kit")).toEqual([["Kit after the switch.", "kit"]]);
  });
});

const realSetImmediate = globalThis.setImmediate.bind(globalThis);
const statusOf = (rig: Rig) =>
  rig
    .sentMessages()
    .map((message) => message.session?.status as string | undefined)
    .filter(Boolean)
    .at(-1);

describe("Neon final at 78bdb111: every Sarvam socket fails, closes and counts on its own", () => {
  it("a socket that drops takes down only its own turn, so another speaker's open turn keeps its words and its answer", async () => {
    const rig = await startRig(SARVAM);
    await sendNamed(rig, named(150), ada);
    const adaLane = await laneOf(rig, ada);
    await sendNamed(rig, named(220), grace);
    const graceLane = await laneOf(rig, grace);
    graceLane.emit(sarvamSpeechStart());
    graceLane.emit(sarvamFinal("g1", "Grace one."));
    adaLane.disconnect();
    await vi.advanceTimersByTimeAsync(500);
    graceLane.emit(sarvamSpeechStart());
    graceLane.emit(sarvamFinal("g2", "Grace two."));
    await rig.clear(grace);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(shown(rig).filter(([, speaker]) => speaker === "grace")).toEqual([["Grace one. Grace two.", "grace"]]);
  });

  it("a key Sarvam rejects when a second speaker's connection opens fails the session instead of reconnecting", async () => {
    const rig = await startRig(SARVAM);
    await rig.speak(ada);
    rig.connectPlans.push({ status: 401 });
    await rig.speak(grace);
    await vi.advanceTimersByTimeAsync(5_000);

    expect([statusOf(rig), rig.providerRequestCount()]).toEqual(["takeover_needed", 2]);
  });

  it("the connection opened at start closes once nobody has spoken for the idle period", async () => {
    const rig = await startRig(SARVAM);
    const [first] = rig.providerSockets();
    await vi.advanceTimersByTimeAsync(40_000);

    expect(first.closed).toBe(true);
  });

  it("a late second part of a turn lands on that turn even after the speaker has spoken again", async () => {
    const rig = await startRig(SARVAM);
    await sendNamed(rig, named(150), ada);
    await rig.clear(ada);
    const turnOne = await laneOf(rig, ada);
    turnOne.emit(sarvamSpeechStart());
    turnOne.emit(sarvamFinal("p1", "Part one."));
    await vi.advanceTimersByTimeAsync(3_000);
    await sendNamed(rig, named(210), ada);
    await rig.clear(ada);
    const turnTwo = await laneOf(rig, ada);
    turnOne.emit(sarvamSpeechStart());
    turnOne.emit(sarvamFinal("p2", "Part two."));
    turnTwo.emit(sarvamSpeechStart());
    turnTwo.emit(sarvamFinal("n", "Next turn."));
    await vi.advanceTimersByTimeAsync(4_000);

    expect(shown(rig)).toEqual([
      ["Part one. Part two.", "ada"],
      ["Next turn.", "ada"],
    ]);
  });

  it("a heard turn whose only answer is empty ends as a gap, never as nothing", async () => {
    const rig = await startRig(SARVAM);
    await sendNamed(rig, named(150), ada);
    await rig.clear(ada);
    const lane = await laneOf(rig, ada);
    lane.emit(sarvamSpeechStart());
    lane.emit(sarvamFinal("e", ""));
    await vi.advanceTimersByTimeAsync(DEADLINE + 5_000);

    expect(shown(rig)).toEqual([[GAP, "ada"]]);
  });

  it("a heard turn whose voiced audio the limit evicted still ends as a gap after its replay", async () => {
    const rig = await startRig(SARVAM);
    type Held = { sequence: number; voice: string; speaker: { userId: string } };
    const held = () => (rig.room as unknown as { audio: { all(): readonly Held[] } }).audio.all();
    await sendNamed(rig, named(150), ada);
    await vi.advanceTimersByTimeAsync(700);
    await sendNamed(rig, pcmBase64(voicedPcm(-80, 200, 150)), ada);
    rig.connectPlans.push({ lateMs: 60_000 });
    (await laneOf(rig, ada)).disconnect();
    await settle();
    const voiced = held().find(({ speaker, voice }) => speaker.userId === "ada" && voice !== "quiet")!.sequence;
    const filler = named(230);
    for (let index = 0; index < 2_000 && held().some(({ sequence }) => sequence === voiced); index += 1) {
      await sendNamed(rig, filler, grace);
      if (index % 400 === 399) await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(held().filter(({ speaker }) => speaker.userId === "ada").map(({ voice }) => voice)).toEqual(["quiet"]);
    await vi.advanceTimersByTimeAsync(60_000 + DEADLINE + 5_000);

    expect(shown(rig).filter(([, speaker]) => speaker === "ada")).toEqual([[GAP, "ada"]]);
  });

  it("a fifth speaker never closes a connection whose turn still owes an answer", async () => {
    const rig = await startRig(SARVAM);
    await sendNamed(rig, named(150), ada);
    await rig.clear(ada);
    const adaLane = await laneOf(rig, ada);
    adaLane.emit(sarvamSpeechStart());
    adaLane.emit(sarvamFinal("a1", "Ada one."));
    await vi.advanceTimersByTimeAsync(2_800);
    adaLane.emit(sarvamSpeechStart());
    for (const [index, person] of [grace, lin, mo].entries()) await sendNamed(rig, named(180 + index * 20), person);
    await sendNamed(rig, named(260), kit);
    await settle();
    adaLane.emit(sarvamFinal("a2", "Ada late."));
    await vi.advanceTimersByTimeAsync(4_000);

    expect(shown(rig).filter(([, speaker]) => speaker === "ada")).toEqual([["Ada one. Ada late.", "ada"]]);
  });

  it("a turn waiting for its answer never holds the speaker's next turn while other connections sit idle", async () => {
    const rig = await startRig(SARVAM);
    for (const [index, person] of [grace, lin, mo].entries()) {
      await sendNamed(rig, named(180 + index * 20), person);
      await answerTurn(rig, person, `w${index}`, `Warm ${index}.`);
      await rig.clear(person);
    }
    await vi.advanceTimersByTimeAsync(3_000);
    await sendNamed(rig, named(150), ada);
    await rig.clear(ada);
    (await laneOf(rig, ada)).emit(sarvamSpeechStart());
    await vi.advanceTimersByTimeAsync(6_000);
    const next = named(240);
    await sendNamed(rig, next, ada);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(openSockets(rig).some((socket) => carriesAudio(socket, next))).toBe(true);
  });

  it("continuous quiet hum without a clear never keeps a connection from a speaker who talks", async () => {
    const rig = await startRig(SARVAM);
    const hums = Array.from({ length: 33 }, (_, index) => pcmBase64(voicedPcm(-58, 200, 120 + index)));
    for (let step = 0; step < 300; step += 1) {
      for (const [index, person] of [ada, grace, lin, mo].entries()) await sendNamed(rig, hums[index * 7 + (step % 5)], person);
      await vi.advanceTimersByTimeAsync(200);
    }
    const kitAudio = named(260);
    await sendNamed(rig, kitAudio, kit);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(openSockets(rig).some((socket) => carriesAudio(socket, kitAudio))).toBe(true);
  });

  it("a stop while the relay token is being signed leaves no snapshot behind", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const rig = await transcriptRoomRig(lookup, SARVAM, { TRANSCRIPT_TOKEN_SECRET: "stop-race-secret" });
    const realSign = crypto.subtle.sign.bind(crypto.subtle);
    let release = () => {};
    const signed = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args: Parameters<SubtleCrypto["sign"]>) => {
      await signed;
      return realSign(...args);
    });
    const starting = rig.start("hi");
    for (let turn = 0; turn < 2_000 && statusOf(rig) !== "live"; turn += 1) {
      await new Promise((resolve) => realSetImmediate(resolve));
    }
    await rig.stop();
    release();
    await starting;
    for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => realSetImmediate(resolve));

    expect(rig.stored.snapshot).toBe(false);
  });

  it("a whitespace-only OpenAI delta followed by an empty final leaves no partial on viewers' screens", async () => {
    const rig = await startRig(OPENAI);
    const [socket] = rig.providerSockets();
    await rig.speak(ada);
    await rig.commit(ada);
    socket.emit(openAiCommitted("blank"));
    socket.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "blank", delta: " " });
    socket.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "blank", transcript: "" });
    await settle();

    expect(Array.from(rig.viewerTranscript().partials.values())).toEqual([]);
  });
});

describe("a Sarvam turn's own socket ends it with words or a gap", () => {
  it("a repeated START_SPEECH with one answer shows its words at once and never adds a gap marker", async () => {
    const rig = await startRig(SARVAM);
    await sendNamed(rig, named(150), ada);
    const turn = await laneOf(rig, ada);
    turn.emit(sarvamSpeechStart());
    await vi.advanceTimersByTimeAsync(400);
    turn.emit(sarvamSpeechStart());
    await rig.clear(ada);
    turn.emit(sarvamFinal("once", "Said once."));
    await vi.advanceTimersByTimeAsync(1_000);
    const soon = rig.broadcastFinals();
    await vi.advanceTimersByTimeAsync(DEADLINE + 5_000);

    expect([soon, shown(rig)]).toEqual([["Said once."], [["Said once.", "ada"]]]);
  });

  it("a turn with two utterances stays a partial until Sarvam has answered both", async () => {
    const rig = await startRig(SARVAM);
    await sendNamed(rig, named(150), ada);
    const turn = await laneOf(rig, ada);
    turn.emit(sarvamSpeechStart());
    turn.emit(sarvamSpeechEnd());
    turn.emit(sarvamFinal("one", "First."));
    turn.emit(sarvamSpeechStart());
    await rig.clear(ada);
    await vi.advanceTimersByTimeAsync(1_000);
    const partial = [shown(rig), Array.from(rig.viewerTranscript().partials.values(), ({ text }) => text)];
    turn.emit(sarvamSpeechEnd());
    turn.emit(sarvamFinal("two", "Second."));
    await vi.advanceTimersByTimeAsync(1_000);

    expect([partial, shown(rig)]).toEqual([[[], ["First."]], [["First. Second.", "ada"]]]);
  });

  it("a socket that drops after its turn showed words, while Sarvam still owes a second part, keeps the words and marks the rest", async () => {
    const rig = await startRig(SARVAM);
    await sendNamed(rig, named(150), ada);
    const turn = await laneOf(rig, ada);
    turn.emit(sarvamSpeechStart());
    await rig.clear(ada);
    turn.emit(sarvamFinal("p1", "Part one."));
    await vi.advanceTimersByTimeAsync(500);
    turn.emit(sarvamSpeechStart());
    turn.disconnect();
    await vi.advanceTimersByTimeAsync(DEADLINE + 5_000);

    expect(shown(rig)).toEqual([[`Part one. ${GAP}`, "ada"]]);
  });

  it("a turn replayed after its socket drops opens a turn of its own, so it never shares an answer with the speaker's newer speech", async () => {
    const rig = await startRig(SARVAM);
    const older = named(150);
    await sendNamed(rig, older, ada);
    const first = await laneOf(rig, ada);
    first.emit(sarvamSpeechStart());
    await rig.clear(ada);
    await vi.advanceTimersByTimeAsync(500);
    await sendNamed(rig, named(210), ada);
    const second = await laneOf(rig, ada);
    second.emit(sarvamSpeechStart());
    first.disconnect();
    await settle();
    const replay = await laneOf(rig, ada);
    replay.emit(sarvamSpeechStart());
    replay.emit(sarvamFinal("r", "One."));
    second.emit(sarvamFinal("t", "Two."));
    await vi.advanceTimersByTimeAsync(4_000);

    expect([replay === second, carriesAudio(second, older), carriesAudio(replay, older)]).toEqual([false, false, true]);
    expect(shown(rig)).toEqual([
      ["One.", "ada"],
      ["Two.", "ada"],
    ]);
  });
});

describe("every way one Sarvam connection can fail stays with its own turn", () => {
  it("a connection that stops taking audio mid-turn takes down only its own turn, and its speaker's audio moves to new connections", async () => {
    const rig = await startRig(SARVAM);
    await sendNamed(rig, named(150), ada);
    const adaLane = await laneOf(rig, ada);
    adaLane.emit(sarvamSpeechStart());
    adaLane.emit(sarvamFinal("a1", "Ada one."));
    rig.connectPlans.push(1);
    const graceAudio = [named(220), named(240)];
    await sendNamed(rig, graceAudio[0], grace);
    const failing = await laneOf(rig, grace);
    await sendNamed(rig, graceAudio[1], grace);
    await vi.advanceTimersByTimeAsync(2_000);
    adaLane.emit(sarvamSpeechEnd());
    adaLane.emit(sarvamSpeechStart());
    adaLane.emit(sarvamFinal("a2", "Ada two."));
    await rig.clear(ada);
    await vi.advanceTimersByTimeAsync(4_000);

    const elsewhere = (audio: string) => rig.providerSockets().some((socket) => socket !== failing && carriesAudio(socket, audio));
    expect(shown(rig).filter(([, speaker]) => speaker === "ada")).toEqual([["Ada one. Ada two.", "ada"]]);
    expect(graceAudio.map(elsewhere)).toEqual([true, true]);
  });

  it("a speaker whose connection keeps failing to open is retried after growing waits, never in a burst", async () => {
    const rig = await startRig(SARVAM);
    await sendNamed(rig, named(150), ada);
    for (let attempt = 0; attempt < 6; attempt += 1) rig.connectPlans.push({ status: 503 });
    await sendNamed(rig, named(220), grace);
    await settle();
    const atOnce = rig.providerRequestCount();
    await vi.advanceTimersByTimeAsync(3_000);

    expect([atOnce, rig.providerRequestCount()]).toEqual([2, 4]);
  });

  it("a connection still opening when its session ends is cancelled, so the next session never opens a fifth beside it", async () => {
    const rig = await startRig(SARVAM);
    await sendNamed(rig, named(150), ada);
    rig.connectPlans.push({ lateMs: 20_000 });
    await sendNamed(rig, named(260), mo);
    await settle();
    await rig.stop();
    const openingAfterStop = rig.openingProviderSockets();
    await rig.start("hi");
    for (const [index, person] of [ada, grace, lin, kit].entries()) await sendNamed(rig, named(170 + index * 20), person);
    await settle();

    expect([openingAfterStop, openSockets(rig).length + rig.openingProviderSockets()]).toEqual([0, 4]);
  });

  it.each(["stop and restart", "takeover"] as const)("%s frees the pending Sarvam open's slot for a fourth speaker", async (action) => {
    vi.useFakeTimers();
    const rig = await transcriptRoomRig(lookup, SARVAM);
    const start = (type: "session.start" | "session.takeover", language: string) =>
      rig.send({ type, language, transcriptModel: SARVAM, transportMode: "sfu" });
    rig.connectPlans.push({ lateMs: 20_000 });
    const abandoned = start("session.start", "hi");
    await settle();
    expect(rig.openingProviderSockets()).toBe(1);

    if (action === "stop and restart") {
      await rig.stop();
      await start("session.start", "hi");
    } else {
      await start("session.takeover", "ta");
    }
    const speech = [ada, grace, lin, mo].map((speaker, index) => ({
      speaker,
      audio: named(150 + index * 30),
    }));
    for (const { speaker, audio } of speech) await sendNamed(rig, audio, speaker);
    await settle();

    const stillOpening = rig.openingProviderSockets();
    const reached = speech.map(({ audio }) => openSockets(rig).some((socket) => carriesAudio(socket, audio)));
    await vi.advanceTimersByTimeAsync(20_000);
    await abandoned;
    expect({ stillOpening, reached }).toEqual({ stillOpening: 0, reached: [true, true, true, true] });
    expect(statusOf(rig)).toBe("live");
  });
});

describe("audio the room holds for Sarvam is sent as soon as a connection can take it", () => {
  it("a speaker whose turn the quiet timer ended, with no clear from the relay, is heard again on a new connection at once", async () => {
    const rig = await startRig(SARVAM);
    await sendNamed(rig, named(150), ada);
    await answerTurn(rig, ada, "one", "One.");
    await vi.advanceTimersByTimeAsync(5_000);
    const next = named(210);
    await sendNamed(rig, next, ada);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(openSockets(rig).some((socket) => carriesAudio(socket, next))).toBe(true);
  });

  it("speech a speaker adds while their dropped turn is replayed follows the replay without waiting for anyone else", async () => {
    const rig = await startRig(SARVAM);
    await sendNamed(rig, named(150), ada);
    const first = await laneOf(rig, ada);
    first.emit(sarvamSpeechStart());
    await rig.clear(ada);
    rig.connectPlans.push({ lateMs: 2_000 });
    first.disconnect();
    await settle();
    const next = named(210);
    await sendNamed(rig, next, ada);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(rig.providerSockets().some((socket) => carriesAudio(socket, next))).toBe(true);
  });
});

describe("quiet audio is hum only when Sarvam hears nothing in it either", () => {
  const quietChunks = Array.from({ length: 6 }, (_, index) => pcmBase64(voicedPcm(-58, 200, 130 + index)));
  const carried = (rig: Rig, audio: string) => rig.providerSockets().some((socket) => carriesAudio(socket, audio));

  it("a soft-spoken speaker Sarvam hears is still captioned after ten seconds of quiet audio", async () => {
    const rig = await startRig(SARVAM);
    const late = pcmBase64(voicedPcm(-58, 200, 177));
    for (let step = 0; step < 100; step += 1) {
      await sendNamed(rig, step === 90 ? late : quietChunks[step % 5], ada);
      if (step % 10 === 5) {
        const turn = await laneOf(rig, ada);
        turn.emit(sarvamSpeechStart());
        turn.emit(sarvamSpeechEnd());
      }
      await vi.advanceTimersByTimeAsync(200);
    }

    expect(carried(rig, late)).toBe(true);
  });

  it("quiet audio long after a speaker's last quiet audio is still sent to Sarvam", async () => {
    const rig = await startRig(SARVAM);
    await sendNamed(rig, whisper, ada);
    await rig.clear(ada);
    await vi.advanceTimersByTimeAsync(20_000);
    const later = pcmBase64(voicedPcm(-56, 200, 190));
    await sendNamed(rig, later, ada);
    await settle();

    expect(carried(rig, later)).toBe(true);
  });

  it("a backlog of quiet audio sent in one burst is not called hum before Sarvam has had ten seconds to hear it", async () => {
    const rig = await startRig(SARVAM);
    await sendNamed(rig, named(150), grace);
    rig.connectPlans.push({ lateMs: 13_000 });
    const backlog = Array.from({ length: 60 }, (_, index) => pcmBase64(voicedPcm(-58, 200, 200 + index)));
    for (const chunk of backlog) {
      await sendNamed(rig, chunk, ada);
      await vi.advanceTimersByTimeAsync(200);
    }
    await vi.advanceTimersByTimeAsync(2_000);

    expect(backlog.filter((chunk) => !carried(rig, chunk)).length).toBe(0);
  });

  it("quiet speech waiting for a new turn after a clear is still sent and captioned", async () => {
    const rig = await startRig(SARVAM);
    for (let step = 0; step < 10; step += 1) {
      await sendNamed(rig, quietChunks[step % 5], ada);
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(carried(rig, quietChunks[0])).toBe(true);
    await rig.clear(ada);
    rig.connectPlans.push({ lateMs: 9_000 });
    const backlog = Array.from({ length: 45 }, (_, index) => pcmBase64(voicedPcm(-58, 200, 200 + index)));
    for (const chunk of backlog) {
      await vi.advanceTimersByTimeAsync(200);
      await sendNamed(rig, chunk, ada);
    }
    await vi.advanceTimersByTimeAsync(200);

    const replacement = rig.providerSockets()[1];
    expect(replacement).toBeDefined();
    expect(backlog.filter((chunk) => !carriesAudio(replacement, chunk))).toHaveLength(0);
    replacement.emit(sarvamSpeechStart());
    await rig.clear(ada);
    replacement.emit(sarvamFinal("quiet-speech", "Still here."));
    await settle();
    expect(shown(rig)).toEqual([["Still here.", "ada"]]);
  });

  it.each([false, true])("hum Sarvam hears nothing in is held back and offered again a minute later (clears: %s)", async (clears) => {
    const rig = await startRig(SARVAM);
    const during = pcmBase64(voicedPcm(-58, 200, 171));
    const after = pcmBase64(voicedPcm(-58, 200, 173));
    for (let step = 0; step < 375; step += 1) {
      if (clears && step % 25 === 0) await rig.clear(ada);
      await sendNamed(rig, step === 150 ? during : step === 360 ? after : quietChunks[step % 5], ada);
      await vi.advanceTimersByTimeAsync(200);
    }

    expect([carried(rig, during), carried(rig, after)]).toEqual([false, true]);
  });
});

describe("a turn Sarvam still owes an answer is never closed as if it were complete", () => {
  const owingTurn = async (rig: Rig) => {
    await sendNamed(rig, named(150), ada);
    const turn = await laneOf(rig, ada);
    turn.emit(sarvamSpeechStart());
    turn.emit(sarvamSpeechEnd());
    await rig.clear(ada);
    turn.emit(sarvamFinal("p1", "Part one."));
    await vi.advanceTimersByTimeAsync(500);
    turn.emit(sarvamSpeechStart());
    return turn;
  };

  it("a language switch keeps the old connection open for a second part Sarvam has started, and shows it", async () => {
    const rig = await startRig(SARVAM);
    const turn = await owingTurn(rig);
    await rig.switchTo("ta");
    await vi.advanceTimersByTimeAsync(15_000);
    turn.emit(sarvamFinal("p2", "Part two."));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(shown(rig)).toEqual([["Part one. Part two.", "ada"]]);
  });

  it("after a language switch, a second part that never comes leaves the gap marker on its caption", async () => {
    const rig = await startRig(SARVAM);
    await owingTurn(rig);
    await rig.switchTo("ta");
    await vi.advanceTimersByTimeAsync(DEADLINE + 15_000);

    expect(shown(rig)).toEqual([[`Part one. ${GAP}`, "ada"]]);
  });

  const rejectAKeyDuringASwitch = async (rig: Rig) => {
    rig.connectPlans.push({ lateMs: 5_000 }, { status: 401 });
    void rig.switchTo("ta");
    await settle();
    await sendNamed(rig, named(260), grace);
    await vi.advanceTimersByTimeAsync(DEADLINE + 15_000);
  };

  it("a key rejected during a language switch ends the old connection's captions where they stand: words keep a gap marker and are never sent again", async () => {
    const rig = await startRig(SARVAM);
    await owingTurn(rig);
    const kitAudio = named(230);
    await sendNamed(rig, kitAudio, kit);
    const kitTurn = await laneOf(rig, kit);
    kitTurn.emit(sarvamSpeechStart());
    kitTurn.emit(sarvamFinal("k", "Kit so far."));
    await settle();
    const before = rig.providerSockets().length;
    await rejectAKeyDuringASwitch(rig);

    expect(shown(rig).filter(([, speaker]) => speaker !== "grace")).toEqual([
      [`Part one. ${GAP}`, "ada"],
      [`Kit so far. ${GAP}`, "kit"],
    ]);
    expect(rig.providerSockets().slice(before).some((socket) => carriesAudio(socket, kitAudio))).toBe(false);
  });

  it("a key rejected during a language switch never sends a noise turn to the next connection", async () => {
    const rig = await startRig(SARVAM);
    const noise = pcmBase64(noisePcm(-60, 200, 9));
    await sendNamed(rig, noise, lin);
    await settle();
    const before = rig.providerSockets().length;
    await rejectAKeyDuringASwitch(rig);

    expect([rig.providerSockets().slice(before).some((socket) => carriesAudio(socket, noise)), shown(rig).filter(([, speaker]) => speaker === "lin")]).toEqual([false, []]);
  });
});

describe("each lost turn gets one more try, and one waiting speaker holds nobody else", () => {
  it("a turn whose replay connection also drops is not replayed again and ends as a gap", async () => {
    const rig = await startRig(SARVAM);
    const audio = named(150);
    await sendNamed(rig, audio, ada);
    const first = await laneOf(rig, ada);
    first.emit(sarvamSpeechStart());
    await rig.clear(ada);
    first.disconnect();
    await settle();
    const replay = await laneOf(rig, ada);
    replay.emit(sarvamSpeechStart());
    replay.disconnect();
    await vi.advanceTimersByTimeAsync(DEADLINE + 5_000);

    expect([rig.providerSockets().filter((socket) => carriesAudio(socket, audio)).length, shown(rig)]).toEqual([2, [[GAP, "ada"]]]);
  });

  it("a quiet turn whose first answer is empty still shows the words Sarvam sends after it", async () => {
    const rig = await startRig(SARVAM);
    const [first] = rig.providerSockets();
    await sendNamed(rig, whisper, ada);
    await rig.clear(ada);
    first.emit(sarvamSpeechStart());
    first.emit(sarvamFinal("empty", ""));
    await vi.advanceTimersByTimeAsync(1_000);
    first.emit(sarvamSpeechStart());
    first.emit(sarvamFinal("q", "Quiet words."));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(shown(rig)).toEqual([["Quiet words.", "ada"]]);
  });

  it("a speaker waiting for a connection to open never holds up another speaker's audio", async () => {
    const rig = await startRig(SARVAM);
    await sendNamed(rig, named(150), ada);
    rig.connectPlans.push({ lateMs: 5_000 });
    await sendNamed(rig, named(220), grace);
    const adaNext = named(170);
    await sendNamed(rig, adaNext, ada);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(openSockets(rig).some((socket) => carriesAudio(socket, adaNext))).toBe(true);
  });
});

describe("a line and its connection end together at thirty seconds", () => {
  it("a quiet turn's connection closes when its line's thirty seconds are up, so a later answer goes nowhere", async () => {
    const rig = await startRig(SARVAM);
    const [first] = rig.providerSockets();
    await sendNamed(rig, whisper, ada);
    await vi.advanceTimersByTimeAsync(DEADLINE + 500);
    const closedWithItsLine = first.closed;
    first.emit(sarvamSpeechStart());
    first.emit(sarvamFinal("late", "Too late."));
    await vi.advanceTimersByTimeAsync(5_000);

    expect([closedWithItsLine, shown(rig)]).toEqual([true, []]);
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
