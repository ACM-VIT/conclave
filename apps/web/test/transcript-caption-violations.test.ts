import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPTION_GAP_MARKER as GAP,
  TRANSCRIPTION_LINE_DEADLINE_MS as DEADLINE,
} from "../transcript-worker/src/constants";
import { Pcm24To16Downsampler } from "../transcript-worker/src/transcription/sarvam";
import { pcmBase64, voicedPcm } from "./transcript-audio-fixtures";
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
    await vi.advanceTimersByTimeAsync(2_000);

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
