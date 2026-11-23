import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPTION_GAP_MARKER as GAP,
  TRANSCRIPTION_LINE_DEADLINE_MS as DEADLINE,
} from "../transcript-worker/src/constants";
import { Pcm24To16Downsampler } from "../transcript-worker/src/transcription/sarvam";
import {
  AUDIO,
  OPENAI,
  SARVAM,
  openAiCommitted,
  openAiDelta,
  openAiFinal,
  sarvamFinal,
  sarvamSpeechEnd,
  sarvamSpeechStart,
  seeded,
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

const rig = (transcriptModel: string) => transcriptRoomRig(lookup, transcriptModel);
const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

describe("speech a provider accepted is never lost without a trace", () => {
  it("OpenAI: a restart after the switch keeps a gap where the acknowledged French line was", async () => {
    vi.useFakeTimers();
    const { providerSockets, start, switchTo, speak, commit, restartedTexts } = await rig(OPENAI);
    await start("fr");
    const [french] = providerSockets();
    await speak();
    await commit();
    french.emit(openAiCommitted("fr_1"));
    await settle();

    await switchTo("de");
    const german = providerSockets()[1];
    await speak();
    await commit();
    german.emit(openAiCommitted("de_1"));
    german.emit(openAiFinal("de_1", "Second spoken line"));
    await settle();

    expect(await restartedTexts()).toEqual([GAP, "Second spoken line"]);
  });

  it("Sarvam: a Bengali final 15 s after the switch to Hindi still lands ahead of the Hindi line", async () => {
    vi.useFakeTimers();
    const { providerSockets, start, switchTo, speak, endTurn, savedTexts } = await rig(SARVAM);
    await start("bn");
    const [bengali] = providerSockets();
    await speak();
    await endTurn();

    await switchTo("hi");
    const hindi = providerSockets()[1];
    await speak();
    await endTurn();
    hindi.emit(sarvamFinal("hi", "Hindi line."));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(bengali.closed).toBe(false);
    bengali.emit(sarvamFinal("bn", "Bengali line."));
    await settle();

    expect(savedTexts()).toEqual(["Bengali line.", "Hindi line."]);
    expect(bengali.closed).toBe(true);
  });
});

describe("every accepted line ends once, as its text or a gap", () => {
  it("OpenAI: a restart keeps a gap for a live line acknowledged with no text yet", async () => {
    vi.useFakeTimers();
    const { providerSockets, start, speak, commit, savedTexts, restartedTexts } = await rig(OPENAI);
    await start("en");
    const [socket] = providerSockets();
    await speak();
    await commit();
    socket.emit(openAiCommitted("item_1"));
    await settle();

    expect(await restartedTexts()).toEqual([GAP]);
    socket.emit(openAiFinal("item_1", "Finished."));
    await settle();
    expect(savedTexts()).toEqual(["Finished."]);
    expect(await restartedTexts()).toEqual(["Finished."]);
  });

  it("OpenAI: a live line with no final ends as a gap at its deadline, and a late final fills that same place", async () => {
    vi.useFakeTimers();
    const warn = quiet();
    const { providerSockets, start, speak, commit, savedTexts, broadcastPlacesByWords } = await rig(OPENAI);
    await start("en");
    const [socket] = providerSockets();
    for (const itemId of ["a", "b"]) {
      await speak();
      await commit();
      socket.emit(openAiCommitted(itemId));
    }
    socket.emit(openAiFinal("b", "Later."));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);

    expect(savedTexts()).toEqual([GAP, "Later."]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not captioned"), expect.anything());
    socket.emit(openAiFinal("a", "Earlier."));
    await settle();
    expect(savedTexts()).toEqual(["Earlier.", "Later."]);
    expect([...broadcastPlacesByWords().get("Earlier")!]).toHaveLength(1);
  });

  it("OpenAI: a live line that showed words keeps them at its deadline", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, commit, savedTexts } = await rig(OPENAI);
    await start("en");
    const [socket] = providerSockets();
    await speak();
    await commit();
    socket.emit(openAiCommitted("a"));
    socket.emit(openAiDelta("a", "Half a"));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);

    expect(savedTexts()).toEqual(["Half a"]);
  });

  it("OpenAI: a commit the old provider never acknowledges keeps its place and ends as a gap", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, switchTo, speak, commit, savedTexts, restartedTexts } = await rig(OPENAI);
    await start("en");
    const [before] = providerSockets();
    await speak();
    await commit();

    await switchTo("hi");
    const after = providerSockets()[1];
    await speak();
    await commit();
    after.emit(openAiCommitted("new_1"));
    after.emit(openAiFinal("new_1", "New line."));
    await settle();
    expect(await restartedTexts()).toEqual([GAP, "New line."]);

    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual([GAP, "New line."]);
    expect(before.closed).toBe(true);
  });

  it("an empty final ends its line with nothing shown, and the saved snapshot drops its place", async () => {
    vi.useFakeTimers();
    const { providerSockets, start, speak, commit, savedTexts, restartedTexts } = await rig(OPENAI);
    await start("en");
    const [socket] = providerSockets();
    await speak();
    await commit();
    socket.emit(openAiCommitted("a"));
    await settle();
    expect(await restartedTexts()).toEqual([GAP]);

    socket.emit(openAiFinal("a", ""));
    await settle();
    expect(savedTexts()).toEqual([]);
    expect(await restartedTexts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual([]);
  });

  it("a provider failure that needs a takeover ends open lines as gaps", async () => {
    vi.useFakeTimers();
    quiet();
    const { room, providerSockets, start, speak, commit, savedTexts, restartedTexts } = await rig(OPENAI);
    await start("en");
    const [socket] = providerSockets();
    await speak();
    await commit();
    socket.emit(openAiCommitted("a"));
    await speak();
    await commit();
    socket.emit(openAiCommitted("b"));
    socket.emit(openAiDelta("b", "Words on screen"));
    await settle();

    socket.emit({ type: "error", error: { message: "Invalid API key provided." } });
    await settle();

    expect(room.session?.status).toBe("takeover_needed");
    expect(savedTexts()).toEqual([GAP, "Words on screen"]);
    expect(await restartedTexts()).toEqual([GAP, "Words on screen"]);
  });

  it("a reconnect that fails for good ends the lines it was replaying as gaps", async () => {
    vi.useFakeTimers();
    quiet();
    const { room, providerSockets, start, speak, commit, savedTexts, restartedTexts } = await rig(OPENAI);
    await start("en");
    const [socket] = providerSockets();
    await speak();
    await commit();
    socket.emit(openAiCommitted("a"));
    await settle();
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Invalid API key provided."));

    socket.disconnect();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(room.session?.status).toBe("takeover_needed");
    expect(savedTexts()).toEqual([GAP]);
    expect(await restartedTexts()).toEqual([GAP]);
  });

  it("a reconnect that replays a line's audio gives it one line, with no gap", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, commit, savedTexts } = await rig(OPENAI);
    await start("en");
    const [socket] = providerSockets();
    await speak();
    await commit();
    socket.emit(openAiCommitted("a"));
    await settle();

    socket.disconnect();
    await vi.advanceTimersByTimeAsync(5_000);
    const replacement = providerSockets()[1];
    expect(replacement.sentTypes()).toContain("input_audio_buffer.commit");
    replacement.emit(openAiCommitted("a_replayed"));
    replacement.emit(openAiFinal("a_replayed", "Replayed line."));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);

    expect(savedTexts()).toEqual(["Replayed line."]);
  });

  it("Sarvam: a place opens when Sarvam says speech started, and a span it never heard as speech leaves no gap", async () => {
    vi.useFakeTimers();
    const { providerSockets, start, speak, endTurn, savedTexts } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak();
    socket.emit(sarvamSpeechStart());
    await endTurn();
    socket.emit(sarvamFinal("one", "First."));
    await settle();

    await speak();
    await endTurn();
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual(["First."]);
  });

  it("Sarvam: a noise turn takes no place, and the first speech signal takes the place our voice check opened", async () => {
    vi.useFakeTimers();
    const { providerSockets, start, speak, sendAudio, endTurn, savedTexts, restartedTexts } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await sendAudio("noise");
    await endTurn();
    await speak();
    await endTurn();
    expect(await restartedTexts()).toEqual([GAP]);

    socket.emit(sarvamSpeechStart());
    socket.emit(sarvamFinal("spoken", "Spoken."));
    await settle();
    expect(await restartedTexts()).toEqual(["Spoken."]);
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual(["Spoken."]);
  });

  it("Sarvam: speech it reports after the switch keeps the old socket open past the quiet window until the final", async () => {
    vi.useFakeTimers();
    const { providerSockets, start, switchTo, speak, endTurn, savedTexts } = await rig(SARVAM);
    await start("hi");
    const [before] = providerSockets();
    await speak();
    before.emit(sarvamSpeechStart());
    await speak();
    await endTurn();

    await switchTo("ta");
    await vi.advanceTimersByTimeAsync(9_000);
    before.emit(sarvamSpeechStart());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(before.closed).toBe(false);
    before.emit(sarvamFinal("one", "One."));
    before.emit(sarvamFinal("two", "Two."));
    await settle();

    expect(savedTexts()).toEqual(["One.", "Two."]);
    expect(before.closed).toBe(true);
  });

  it("Sarvam: an utterance that never gets its final ends as a gap, live and after a switch", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, switchTo, speak, endTurn, savedTexts } = await rig(SARVAM);
    await start("hi");
    const [before] = providerSockets();
    await speak();
    await endTurn();
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual([GAP]);

    await speak();
    await endTurn();
    await switchTo("ta");
    await vi.advanceTimersByTimeAsync(DEADLINE - 1_000);
    expect(before.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(savedTexts()).toEqual([GAP, GAP]);
    expect(before.closed).toBe(true);
  });
});

describe("a gap means our side heard speech", () => {
  it.each(["noise", "clicks", "silence"] as const)(
    "Sarvam: a %s turn before any speech signal never takes a place or leaves a gap",
    async (kind) => {
      vi.useFakeTimers();
      const { start, sendAudio, endTurn, savedTexts, restartedTexts } = await rig(SARVAM);
      await start("hi");
      for (const _ of [1, 2, 3]) await sendAudio(kind);
      await endTurn();
      expect(await restartedTexts()).toEqual([]);
      await vi.advanceTimersByTimeAsync(DEADLINE + 100);
      expect(savedTexts()).toEqual([]);
    },
  );

  it("Sarvam: the first quiet 30 s after connecting leaves no gap", async () => {
    vi.useFakeTimers();
    const { start, sendAudio, endTurn, savedTexts } = await rig(SARVAM);
    await start("hi");
    for (let index = 0; index < 160; index += 1) {
      await sendAudio(index % 2 ? "noise" : "silence");
      await vi.advanceTimersByTimeAsync(200);
    }
    await endTurn();
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual([]);
  });

  it("Sarvam: a false start our voice check heard nothing in ends with nothing shown", async () => {
    vi.useFakeTimers();
    const { providerSockets, start, speak, sendAudio, endTurn, savedTexts, restartedTexts } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak();
    socket.emit(sarvamSpeechStart());
    await endTurn();
    socket.emit(sarvamFinal("one", "First."));
    await vi.advanceTimersByTimeAsync(2_000);

    await sendAudio("noise");
    socket.emit(sarvamSpeechStart());
    await endTurn();
    expect(await restartedTexts()).toEqual(["First."]);
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual(["First."]);
  });

  it("Sarvam: speech right after a false start belongs to its own signal, so the false start leaves no gap", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, sendAudio, endTurn, savedTexts } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak();
    socket.emit(sarvamSpeechStart());
    await endTurn();
    socket.emit(sarvamFinal("one", "First."));
    await vi.advanceTimersByTimeAsync(2_000);

    await sendAudio("noise");
    await endTurn();
    socket.emit(sarvamSpeechStart());
    await vi.advanceTimersByTimeAsync(400);
    await speak();
    socket.emit(sarvamSpeechStart());
    await endTurn();
    socket.emit(sarvamFinal("two", ""));
    socket.emit(sarvamFinal("three", "Second."));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual(["First.", "Second."]);
  });

  it("Sarvam: a false start right before someone talks on under their own signal leaves no gap", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, sendAudio, endTurn, savedTexts, restartedTexts } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak();
    socket.emit(sarvamSpeechStart());
    await endTurn();
    socket.emit(sarvamFinal("one", "First."));
    await vi.advanceTimersByTimeAsync(2_000);

    await sendAudio("noise");
    await endTurn();
    socket.emit(sarvamSpeechStart());
    await speak();
    socket.emit(sarvamSpeechStart());
    for (const _ of [1, 2, 3, 4, 5, 6]) {
      await vi.advanceTimersByTimeAsync(250);
      await speak();
    }
    await endTurn();
    await vi.advanceTimersByTimeAsync(1_600);
    expect(await restartedTexts()).toEqual(["First.", GAP]);

    socket.emit(sarvamFinal("two", ""));
    socket.emit(sarvamFinal("three", "Second."));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual(["First.", "Second."]);
  });

  it("Sarvam: a false start on speech our voice check heard ends as a gap", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, endTurn, savedTexts } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak();
    socket.emit(sarvamSpeechStart());
    await endTurn();
    socket.emit(sarvamFinal("one", "First."));
    await vi.advanceTimersByTimeAsync(2_000);

    await speak();
    socket.emit(sarvamSpeechStart());
    await endTurn();
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual(["First.", GAP]);
  });

  it("Sarvam: a speech signal that comes before our check hears the onset is heard once it does", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, endTurn, savedTexts, restartedTexts } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak();
    socket.emit(sarvamSpeechStart());
    await endTurn();
    socket.emit(sarvamFinal("one", "First."));
    await vi.advanceTimersByTimeAsync(2_000);

    socket.emit(sarvamSpeechStart());
    expect(await restartedTexts()).toEqual(["First."]);
    await vi.advanceTimersByTimeAsync(250);
    await speak();
    await endTurn();
    expect(await restartedTexts()).toEqual(["First."]);
    await vi.advanceTimersByTimeAsync(1_600);
    expect(await restartedTexts()).toEqual(["First.", GAP]);
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual(["First.", GAP]);
  });
});

describe("a line's state lives on its record", () => {
  const ada = { userId: "ada", displayName: "Ada" };
  const guest = { userId: "guest", displayName: "Guest" };

  it("Sarvam: a line's deadline drops only its own replay audio, so a later line still replays", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, endTurn, savedTexts } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak();
    await endTurn();
    await vi.advanceTimersByTimeAsync(20_000);
    await speak();
    await endTurn();
    await vi.advanceTimersByTimeAsync(10_100);
    expect(savedTexts()).toEqual([GAP]);

    socket.disconnect();
    await settle();
    const replacement = providerSockets()[1];
    const replayed = replacement.sent.filter((message) => (message as { audio?: unknown }).audio).length;
    expect(replayed).toBe(1);
    replacement.emit(sarvamFinal("b", "Second line."));
    await settle();
    expect(savedTexts()).toEqual([GAP, "Second line."]);
  });

  it("OpenAI: a restart while a replacement has not acknowledged the replayed audio keeps every accepted line", async () => {
    vi.useFakeTimers();
    quiet();
    const { room, providerSockets, start, speak, commit, savedTexts, restartedTexts, viewerTranscript } = await rig(OPENAI);
    await start("en");
    const [socket] = providerSockets();
    for (const itemId of ["a", "b"]) {
      await speak();
      await commit();
      socket.emit(openAiCommitted(itemId));
    }
    socket.emit(openAiDelta("b", "Words of b"));
    await settle();
    const [shownAs] = viewerTranscript().partials.keys();

    socket.disconnect();
    await settle();
    const replacement = providerSockets()[1];
    expect(replacement.sentTypes().filter((type) => type === "input_audio_buffer.commit")).toHaveLength(2);
    expect(await restartedTexts()).toEqual([GAP, "Words of b"]);

    replacement.emit(openAiCommitted("a2"));
    replacement.emit(openAiCommitted("b2"));
    expect(await restartedTexts(), "words already shown stay until the replacement sends its own").toEqual([GAP, "Words of b"]);
    replacement.emit(openAiFinal("b2", "Line b."));
    replacement.emit(openAiFinal("a2", "Line a."));
    await settle();

    expect(savedTexts()).toEqual(["Line a.", "Line b."]);
    expect(room.segments[1]?.itemId, "a line keeps the itemId viewers already know").toBe(shownAs);
    expect(viewerTranscript().segments.map(({ text }) => text)).toEqual(["Line a.", "Line b."]);
  });

  it("Sarvam: a gap saved for a guest's first chunk names the guest, not the speaker before", async () => {
    vi.useFakeTimers();
    const { providerSockets, start, speak, endTurn, restartedSegments } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak(ada);
    await endTurn(ada);
    socket.emit(sarvamFinal("ada", "Ada speaks."));
    await settle();

    await speak(guest);
    const saved = await restartedSegments();
    expect(saved.map(({ text, speakerUserId }) => [text, speakerUserId])).toEqual([
      ["Ada speaks.", "ada"],
      [GAP, "guest"],
    ]);
  });

  it("OpenAI: each line keeps the speaker of its own commit through a switch and a handoff", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, switchTo, speak, commit, savedTexts, room } = await rig(OPENAI);
    await start("en");
    const [english] = providerSockets();
    await speak(ada);
    await commit(ada);
    await speak(guest);
    await commit(guest);
    english.emit(openAiCommitted("ada_1"));

    await switchTo("hi");
    english.emit(openAiCommitted("guest_1"));
    english.emit(openAiFinal("guest_1", "Guest line."));
    english.emit(openAiFinal("ada_1", "Ada line."));
    await settle();

    expect(savedTexts()).toEqual(["Ada line.", "Guest line."]);
    expect(room.segments.map(({ speakerUserId }) => speakerUserId)).toEqual(["ada", "guest"]);
  });
});

describe("one owner and one release point per line", () => {
  const ada = { userId: "ada", displayName: "Ada" };
  const grace = { userId: "grace", displayName: "Grace" };

  it("Sarvam: words finished before the relay's next commit are never replayed into a second caption", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, endTurn, savedTexts, viewerTranscript } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak(ada);
    socket.emit(sarvamFinal("done", "Already captioned."));
    await settle();

    socket.disconnect();
    await settle();
    const replacement = providerSockets()[1];
    expect(replacement.sent.filter((message) => (message as { audio?: unknown }).audio)).toHaveLength(0);
    await endTurn(ada);
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);

    expect(savedTexts()).toEqual(["Already captioned."]);
    expect(viewerTranscript().segments.map(({ text }) => text)).toEqual(["Already captioned."]);
  });

  it("OpenAI: a line that became a gap before the replacement acked is corrected under the same itemId", async () => {
    vi.useFakeTimers();
    quiet();
    const { room, providerSockets, start, speak, commit, savedTexts, viewerTranscript } = await rig(OPENAI);
    await start("en");
    const [socket] = providerSockets();
    await speak(ada);
    await commit(ada);
    socket.emit(openAiCommitted("a"));
    await settle();

    socket.disconnect();
    await settle();
    const replacement = providerSockets()[1];
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual([GAP]);
    const gapId = room.segments[0]!.itemId;
    replacement.emit(openAiCommitted("a2"));
    replacement.emit(openAiFinal("a2", "Late but right."));
    await settle();

    expect(room.segments.map(({ itemId, text }) => [itemId, text])).toEqual([[gapId, "Late but right."]]);
    expect(viewerTranscript().segments.map(({ itemId, text }) => [itemId, text])).toEqual([[gapId, "Late but right."]]);
  });

  it.each([OPENAI, SARVAM])("%s: nothing a session held for its lines outlives stopping notes", async (model) => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, switchTo, speak, commit, endTurn, stop, retainedLineState } = await rig(model);
    await start(model === OPENAI ? "en" : "hi");
    for (const _ of [1, 2, 3]) {
      await speak(ada);
      await commit(ada);
    }
    providerSockets()[0].emit(openAiCommitted("a"));
    await endTurn(ada);
    providerSockets()[0].disconnect();
    await settle();
    await switchTo(model === OPENAI ? "fr" : "ta");
    await speak(grace);
    await endTurn(grace);
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    await speak(grace);

    await stop();
    expect(retainedLineState()).toEqual({ lines: 0, connections: 0, unownedAudio: 0, bufferedAudio: 0, timers: 0 });
  });

  it("Sarvam: a speech signal that comes after the audio was committed takes that audio and its speaker into a replay", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, endTurn, room, viewerTranscript } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak(ada);
    socket.emit(sarvamSpeechStart());
    socket.emit(sarvamFinal("first", "First."));
    await endTurn(ada);
    await vi.advanceTimersByTimeAsync(2_000);
    await speak(ada);
    await endTurn(ada);
    await speak(grace);
    await endTurn(grace);
    await vi.advanceTimersByTimeAsync(700);
    socket.emit(sarvamSpeechStart());
    socket.emit(sarvamSpeechStart());
    await settle();

    socket.disconnect();
    await settle();
    const replacement = providerSockets()[1];
    replacement.emit(sarvamSpeechStart());
    replacement.emit(sarvamSpeechStart());
    replacement.emit(sarvamFinal("a", "Ada again."));
    replacement.emit(sarvamFinal("g", "Grace now."));
    await settle();

    expect(room.segments.map(({ text, speakerUserId }) => [text, speakerUserId])).toEqual([
      ["First.", "ada"],
      ["Ada again.", "ada"],
      ["Grace now.", "grace"],
    ]);
    expect(viewerTranscript().segments.map(({ text }) => text)).toEqual(["First.", "Ada again.", "Grace now."]);
  });

  it("Sarvam: the second of two close utterances whose final never comes ends as a gap", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, endTurn, savedTexts } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak(ada);
    socket.emit(sarvamSpeechStart());
    socket.emit(sarvamFinal("first", "First."));
    await endTurn(ada);
    await vi.advanceTimersByTimeAsync(2_000);

    await speak(ada);
    socket.emit(sarvamSpeechStart());
    await vi.advanceTimersByTimeAsync(300);
    await speak(grace);
    await endTurn(grace);
    await vi.advanceTimersByTimeAsync(700);
    socket.emit(sarvamSpeechStart());
    socket.emit(sarvamFinal("second", "Second."));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);

    expect(savedTexts()).toEqual(["First.", "Second.", GAP]);
  });
});

type Provider = "openai" | "sarvam";
type Speaker = { userId: string; displayName: string };
type Connection = {
  socket: FakeProviderSocket;
  provider: Provider;
  unacknowledged: Utterance[];
  awaiting: Utterance[];
  stalled: boolean;
  dead: boolean;
  /** Sarvam has sent it a speech signal, so our voice check no longer opens lines on it. */
  signalled: boolean;
};
type Utterance = {
  index: number;
  text: string;
  noise: boolean;
  speaker: Speaker;
  /** Speech chunks its audio was sent as. */
  chunks: number;
  itemId: string;
  connection: Connection;
  placedAt: number | null;
  deadlineAt: number | null;
  claiming: boolean;
  lost: boolean;
  partial: string | null;
  final: "pending" | "shown" | "ignored" | "failed";
};

const LANGUAGES: Record<Provider, string[]> = { openai: ["en", "fr", "de", "hi"], sarvam: ["hi", "ta", "bn"] };
const SPEAKERS: Speaker[] = [
  { userId: "ada", displayName: "Ada" },
  { userId: "grace", displayName: "Grace" },
  { userId: "guest", displayName: "Guest" },
];
const NOISE_KINDS = ["noise", "clicks", "silence"] as const;
const sarvamSpeechPayload = new Pcm24To16Downsampler().downsample(AUDIO.speech);
const audioOf = (message: Record<string, unknown>) =>
  typeof message.audio === "string"
    ? message.audio
    : (message.audio as { data?: string } | undefined)?.data;

describe("invariant: every utterance a provider accepted ends as its text or a gap in its place", () => {
  it.each(Array.from({ length: 400 }, (_, index) => index + 1))("seed %i", async (seed) => {
    vi.useFakeTimers();
    quiet();
    const random = seeded(seed);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const sarvamSignalsSpeech = random() < 0.5;
    let provider: Provider = random() < 0.5 ? "openai" : "sarvam";
    const model = (of: Provider) => (of === "openai" ? OPENAI : SARVAM);
    const harness = await rig(model(provider));
    const { providerSockets, connectPlans, start, switchTo, useModel, speak, sendAudio, commit, endTurn, stop } = harness;
    await start(pick(LANGUAGES[provider]));

    const connections: Connection[] = [];
    const connect = () => {
      const connection: Connection = {
        socket: providerSockets().at(-1)!,
        provider,
        unacknowledged: [],
        awaiting: [],
        stalled: false,
        dead: false,
        signalled: false,
      };
      connections.push(connection);
      return connection;
    };
    let live = connect();
    const signalSpeech = (connection: Connection) => {
      connection.signalled = true;
      connection.socket.emit(sarvamSpeechStart());
    };
    const utterances: Utterance[] = [];
    let acks = 0;
    const place = (utterance: Utterance, at = Date.now()) => {
      utterance.placedAt ??= at;
      utterance.deadlineAt ??= at + DEADLINE;
    };
    const acknowledge = (connection: Connection) => {
      const utterance = connection.unacknowledged.shift()!;
      utterance.itemId = `ack_${(acks += 1)}`;
      connection.socket.emit(openAiCommitted(utterance.itemId));
      place(utterance);
      if (connection === live && Date.now() >= utterance.deadlineAt!) utterance.deadlineAt = Date.now() + DEADLINE;
      if (utterance.claiming && !connection.socket.closed) utterance.claiming = false;
      connection.awaiting.push(utterance);
    };
    const acknowledgeLive = () => {
      while (live.provider === "openai" && live.unacknowledged.length) acknowledge(live);
    };
    const real = () => utterances.filter(({ noise }) => !noise);
    const expectedText = (utterance: Utterance) =>
      utterance.final === "shown" ? utterance.text : utterance.partial || GAP;
    const retireExpired = (connection: Connection) => {
      while (connection.provider === "sarvam" && connection.awaiting[0] && Date.now() >= connection.awaiting[0].deadlineAt!) {
        connection.awaiting.shift();
      }
    };
    const answerable = (connection: Connection) => {
      retireExpired(connection);
      return connection.provider === "openai" ? connection.awaiting.filter(({ lost }) => !lost) : connection.awaiting;
    };
    const answering = () =>
      connections.filter((connection) => answerable(connection).length && !connection.stalled && !connection.dead);
    const newUtterance = (noise: boolean): Utterance => {
      const utterance: Utterance = {
        index: utterances.length,
        text: noise ? "" : `Line ${utterances.length}.`,
        noise,
        speaker: pick(SPEAKERS),
        chunks: 1,
        itemId: `u${utterances.length}`,
        connection: live,
        placedAt: null,
        deadlineAt: null,
        claiming: false,
        lost: false,
        partial: null,
        final: "pending",
      };
      utterances.push(utterance);
      return utterance;
    };

    const moves: Record<string, () => Promise<void>> = {
      async utter() {
        const utterance = newUtterance(false);
        await speak(utterance.speaker);
        if (live.provider === "openai") {
          await commit(utterance.speaker);
          place(utterance);
          live.unacknowledged.push(utterance);
          if (random() < 0.7) acknowledge(live);
          return;
        }
        if (sarvamSignalsSpeech) signalSpeech(live);
        place(utterance);
        live.awaiting.push(utterance);
        if (live.awaiting.length === 1 && !live.stalled && random() < 0.25) {
          live.awaiting.shift();
          utterance.final = "shown";
          live.socket.emit(sarvamFinal(utterance.itemId, utterance.text));
          await settle();
        }
        await endTurn(utterance.speaker);
      },
      async utterLate() {
        if (live.provider !== "sarvam" || !sarvamSignalsSpeech) return moves.utter();
        const utterance = newUtterance(false);
        await speak(utterance.speaker);
        place(utterance);
        await endTurn(utterance.speaker);
        await vi.advanceTimersByTimeAsync(600 + random() * 800);
        signalSpeech(live);
        utterance.deadlineAt = Date.now() + DEADLINE;
        live.awaiting.push(utterance);
      },
      async signalEarly() {
        if (live.provider !== "sarvam" || !sarvamSignalsSpeech) return moves.utter();
        await vi.advanceTimersByTimeAsync(1_600);
        const utterance = newUtterance(false);
        signalSpeech(live);
        place(utterance);
        live.awaiting.push(utterance);
        await vi.advanceTimersByTimeAsync(50 + random() * 400);
        await speak(utterance.speaker);
        utterance.deadlineAt = Date.now() + DEADLINE;
        await endTurn(utterance.speaker);
        if (answerable(live).length === 1 && !live.stalled && random() < 0.4) {
          await vi.advanceTimersByTimeAsync(100 + random() * 500);
          live.awaiting.shift();
          utterance.final = "shown";
          live.socket.emit(sarvamFinal(utterance.itemId, utterance.text));
          await settle();
          return;
        }
        await vi.advanceTimersByTimeAsync(1_600);
      },
      async monologue() {
        if (live.provider !== "sarvam") return moves.utter();
        const utterance = newUtterance(false);
        await speak(utterance.speaker);
        if (sarvamSignalsSpeech) signalSpeech(live);
        place(utterance);
        live.awaiting.push(utterance);
        for (let elapsed = 0; elapsed < DEADLINE + 2_000; elapsed += 1_000) {
          await vi.advanceTimersByTimeAsync(1_000);
          await speak(utterance.speaker);
          utterance.chunks += 1;
        }
        utterance.deadlineAt = Date.now() + DEADLINE;
        await endTurn(utterance.speaker);
        if (sarvamSignalsSpeech) live.socket.emit(sarvamSpeechEnd());
      },
      async lateTurns() {
        if (live.provider !== "sarvam" || !sarvamSignalsSpeech) return moves.utter();
        await vi.advanceTimersByTimeAsync(1_600);
        const first = newUtterance(false);
        const second = newUtterance(false);
        if (random() < 0.5) second.speaker = first.speaker;
        for (const utterance of [first, second]) {
          await speak(utterance.speaker);
          place(utterance);
          await endTurn(utterance.speaker);
          await vi.advanceTimersByTimeAsync(100 + random() * 200);
        }
        await vi.advanceTimersByTimeAsync(200 + random() * 400);
        for (const utterance of [first, second]) {
          signalSpeech(live);
          utterance.deadlineAt = Date.now() + DEADLINE;
          live.awaiting.push(utterance);
        }
      },
      async lateEnd() {
        if (live.provider !== "sarvam" || !sarvamSignalsSpeech) return moves.utter();
        await vi.advanceTimersByTimeAsync(1_600);
        const first = newUtterance(false);
        await speak(first.speaker);
        signalSpeech(live);
        place(first);
        live.awaiting.push(first);
        await endTurn(first.speaker);
        await vi.advanceTimersByTimeAsync(100 + random() * 400);
        const second = newUtterance(false);
        await speak(second.speaker);
        await endTurn(second.speaker);
        live.socket.emit(sarvamSpeechEnd());
        await vi.advanceTimersByTimeAsync(random() * 300);
        signalSpeech(live);
        place(second);
        live.awaiting.push(second);
      },
      async cough() {
        if (live.provider !== "sarvam" || !live.signalled) return moves.noise();
        await vi.advanceTimersByTimeAsync(1_600);
        const utterance = newUtterance(true);
        await speak(utterance.speaker);
        await endTurn(utterance.speaker);
        await vi.advanceTimersByTimeAsync(3_100);
      },
      async crosstalk() {
        if (live.provider !== "sarvam" || !sarvamSignalsSpeech) return moves.utter();
        await vi.advanceTimersByTimeAsync(1_600);
        const first = newUtterance(false);
        const second = newUtterance(false);
        second.speaker = SPEAKERS.find(({ userId }) => userId !== first.speaker.userId)!;
        for (const utterance of [first, second]) {
          await speak(utterance.speaker);
          await endTurn(utterance.speaker);
        }
        for (const utterance of [first, second]) {
          signalSpeech(live);
          place(utterance);
          live.awaiting.push(utterance);
        }
      },
      async noise() {
        acknowledgeLive();
        await settle();
        await vi.advanceTimersByTimeAsync(600 + random() * 1_000);
        const utterance = newUtterance(true);
        await sendAudio(pick(NOISE_KINDS), utterance.speaker);
        if (live.provider === "openai") {
          await commit(utterance.speaker);
          live.socket.emit(openAiCommitted(`noise_${utterance.index}`));
          live.socket.emit(openAiFinal(`noise_${utterance.index}`, ""));
          return;
        }
        await endTurn(utterance.speaker);
        if (sarvamSignalsSpeech && random() < 0.5) {
          signalSpeech(live);
          place(utterance);
          live.awaiting.push(utterance);
        }
      },
      async acknowledge() {
        const waiting = connections.filter(({ unacknowledged, dead }) => unacknowledged.length && !dead);
        if (waiting.length) acknowledge(pick(waiting));
      },
      async final() {
        const ready = answering();
        if (!ready.length) return;
        const connection = pick(ready);
        const utterance = connection.provider === "openai" ? pick(answerable(connection)) : connection.awaiting[0];
        connection.awaiting.splice(connection.awaiting.indexOf(utterance), 1);
        if (Date.now() < utterance.deadlineAt!) {
          expect(connection.socket.closed, `${utterance.text}: its socket stays open until its deadline`).toBe(false);
        }
        utterance.final = connection.socket.closed ? "ignored" : "shown";
        connection.socket.emit(
          connection.provider === "openai"
            ? openAiFinal(utterance.itemId, utterance.text)
            : sarvamFinal(utterance.itemId, utterance.text),
        );
      },
      async delta() {
        const showing = connections
          .filter(({ provider: of, dead }) => of === "openai" && !dead)
          .flatMap(({ awaiting }) => awaiting.filter(({ partial, noise }) => partial === null && !noise));
        if (!showing.length) return;
        const utterance = pick(showing);
        const words = `${utterance.text} so far`;
        utterance.connection.socket.emit(openAiDelta(utterance.itemId, words));
        const shown = !utterance.connection.socket.closed && Date.now() < utterance.deadlineAt!;
        utterance.partial = shown ? words : "";
      },
      async lose() {
        const ready = answering();
        if (!ready.length) return;
        const connection = pick(ready);
        if (connection.provider === "sarvam") {
          connection.stalled = true;
        } else {
          pick(answerable(connection)).lost = true;
        }
      },
      async wait() {
        acknowledgeLive();
        await settle();
        await vi.advanceTimersByTimeAsync(random() < 0.7 ? 200 + random() * 3_000 : 5_000 + random() * 30_000);
      },
      async switch() {
        const previous = live;
        if (random() < 0.4) {
          provider = provider === "openai" ? "sarvam" : "openai";
          useModel(model(provider));
        }
        const opened = providerSockets().length;
        await switchTo(pick(LANGUAGES[provider]));
        expect(providerSockets()).toHaveLength(opened + 1);
        const now = Date.now();
        for (const utterance of previous.unacknowledged) {
          place(utterance, now);
          utterance.deadlineAt = utterance.deadlineAt! <= now ? now + DEADLINE : Math.min(utterance.deadlineAt!, now + DEADLINE);
        }
        live = connect();
      },
      async disconnect() {
        if (live.dead) return;
        const failed = live;
        const owed = [...failed.awaiting]
          .filter(({ noise, deadlineAt }) => !noise && Date.now() < deadlineAt!)
          .sort((left, right) => left.index - right.index);
        const unacknowledged = [...failed.unacknowledged];
        const picked = pick(["plain", "plain", "midReplay", "unreachable"] as const);
        const kind = picked === "midReplay" && owed.length + unacknowledged.length === 0 ? "plain" : picked;
        if (kind === "midReplay") connectPlans.push(1);
        if (kind === "unreachable") connectPlans.push("unreachable");
        failed.socket.disconnect();
        await settle();
        failed.dead = true;
        failed.awaiting = failed.awaiting.filter((utterance) => !owed.includes(utterance));
        failed.unacknowledged = [];
        const buffered: Utterance[] = [];
        if (kind === "unreachable") {
          while (random() < 0.5) {
            const utterance = newUtterance(false);
            buffered.push(utterance);
            await speak(utterance.speaker);
            await endTurn(utterance.speaker);
          }
          if (random() < 0.4) {
            if (random() < 0.4) {
              provider = provider === "openai" ? "sarvam" : "openai";
              useModel(model(provider));
            }
            await switchTo(pick(LANGUAGES[provider]));
          } else {
            await vi.advanceTimersByTimeAsync(300);
          }
        } else if (kind === "midReplay") {
          await vi.advanceTimersByTimeAsync(300);
        }
        await settle();
        live = connect();
        const now = Date.now();
        for (const utterance of [...owed, ...unacknowledged]) {
          utterance.claiming = true;
          utterance.lost = false;
          utterance.deadlineAt = now + DEADLINE;
        }
        for (const utterance of buffered) {
          utterance.placedAt = now;
          utterance.deadlineAt = now + DEADLINE;
        }
        const replayed = [...owed, ...unacknowledged, ...buffered].sort((left, right) => left.index - right.index);
        for (const utterance of replayed) utterance.connection = live;
        const replayedChunks = replayed.reduce((sum, { chunks }) => sum + chunks, 0);
        const sent = live.socket.sent;
        if (live.provider === "openai") {
          const commits = sent.filter(({ type }) => type === "input_audio_buffer.commit").length;
          const speech = sent.filter((message) => audioOf(message) === AUDIO.speech).length;
          expect(commits, "every owed line's audio is replayed with its commit").toBe(replayed.length);
          expect(speech, "no line's replay audio was dropped by another line ending").toBe(replayedChunks);
          live.unacknowledged = replayed;
        } else {
          const speech = sent.filter((message) => audioOf(message) === sarvamSpeechPayload).length;
          expect(speech, "no line's replay audio was dropped by another line ending").toBe(replayedChunks);
          if (sarvamSignalsSpeech) for (const _ of replayed) signalSpeech(live);
          live.awaiting = replayed;
        }
      },
      async lateAck() {
        if (live.provider !== "openai" || live.dead || live.unacknowledged.length === 0) return;
        const now = Date.now();
        if (live.unacknowledged.some(({ placedAt }) => now - placedAt! > 10_000)) return;
        await vi.advanceTimersByTimeAsync(DEADLINE + 1_000);
        acknowledgeLive();
      },
      async turnPair() {
        if (live.provider !== "sarvam" || live.dead || (!sarvamSignalsSpeech && live.awaiting.length > 0)) {
          return moves.utter();
        }
        const first = newUtterance(false);
        await speak(first.speaker);
        if (sarvamSignalsSpeech) signalSpeech(live);
        place(first);
        live.awaiting.push(first);
        if (!sarvamSignalsSpeech) {
          live.awaiting.shift();
          first.final = "shown";
          live.socket.emit(sarvamFinal(first.itemId, first.text));
          await settle();
        }
        await vi.advanceTimersByTimeAsync(700);
        const second = newUtterance(false);
        second.speaker = first.speaker;
        await speak(second.speaker);
        if (sarvamSignalsSpeech) signalSpeech(live);
        place(second);
        live.awaiting.push(second);
        await endTurn(second.speaker);
      },
      async itemFails() {
        const failing = connections
          .filter(({ provider: of, dead, socket }) => of === "openai" && !dead && !socket.closed)
          .flatMap(({ awaiting }) => awaiting.filter(({ noise, lost, deadlineAt }) => !noise && !lost && Date.now() < deadlineAt!));
        if (failing.length === 0) return;
        const utterance = pick(failing);
        utterance.connection.awaiting.splice(utterance.connection.awaiting.indexOf(utterance), 1);
        utterance.final = "failed";
        utterance.connection.socket.emit({
          type: "conversation.item.input_audio_transcription.failed",
          item_id: utterance.itemId,
          error: { message: "This item could not be transcribed" },
        });
      },
      async restart() {
        const viewer = harness.viewerTranscript();
        expect(
          viewer.segments.map(({ itemId, text }) => [itemId, text]),
          "a viewer shows exactly what the room saved",
        ).toEqual(harness.room.segments.map(({ itemId, text }) => [itemId, text]));
        const placed = real().filter(({ placedAt }) => placedAt !== null);
        const saved = await harness.restartedSegments();
        expect(
          saved.map(({ text }) => text),
          `a restart keeps one place per accepted utterance, and none for noise: expected ${JSON.stringify(placed.map(({ text, final, partial }) => [text, final, partial]))} saved ${JSON.stringify(saved.map(({ text, itemId }) => [text, itemId]))}`,
        ).toHaveLength(placed.length);
        placed.forEach((utterance, index) => {
          const allowed = utterance.final === "shown" ? [utterance.text] : [GAP, ...(utterance.partial ? [utterance.partial] : [])];
          expect(allowed, `${utterance.text} after a restart`).toContain(saved[index]?.text);
          expect(saved[index]?.speakerUserId, `${utterance.text} keeps its speaker after a restart`).toBe(utterance.speaker.userId);
        });
      },
    };
    const weights: [string, number][] = [
      ["utter", 22],
      ["utterLate", 5],
      ["signalEarly", 3],
      ["monologue", 2],
      ["crosstalk", 3],
      ["lateTurns", 3],
      ["lateEnd", 3],
      ["cough", 2],
      ["turnPair", 4],
      ["lateAck", 3],
      ["itemFails", 3],
      ["noise", 10],
      ["final", 22],
      ["delta", 7],
      ["wait", 12],
      ["switch", 8],
      ["disconnect", 5],
      ["lose", 4],
      ["acknowledge", 4],
      ["restart", 8],
    ];
    const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
    for (let step = 0; step < 32; step += 1) {
      let roll = random() * total;
      const [move] = weights.find(([, weight]) => (roll -= weight) < 0) ?? weights[0];
      await moves[move]();
      await settle();
    }

    acknowledgeLive();
    await settle();
    await moves.restart();
    await vi.advanceTimersByTimeAsync(2 * DEADLINE + 15_000);
    const lines = harness.room.segments;
    expect(lines.map(({ text }) => text)).toEqual(real().map(expectedText));
    expect(lines.map(({ speakerUserId }) => speakerUserId), "every line keeps the speaker of its own audio").toEqual(
      real().map(({ speaker }) => speaker.userId),
    );
    expect(await harness.restartedTexts()).toEqual(real().map(expectedText));
    expect(connections.slice(0, -1).every(({ socket }) => socket.closed), "every replaced socket closes").toBe(true);
    const viewer = harness.viewerTranscript();
    expect(viewer.segments.map(({ text }) => text), "a viewer shows each line once, in place").toEqual(real().map(expectedText));
    const words = viewer.segments.map(({ text }) => text).filter((text) => text !== GAP);
    expect(new Set(words).size, "no words appear in two captions").toBe(words.length);
    expect(viewer.partials.size, "no partial outlives its line").toBe(0);
    await stop();
    expect(harness.retainedLineState(), "nothing a line held outlives the session").toEqual({
      lines: 0,
      connections: 0,
      unownedAudio: 0,
      bufferedAudio: 0,
      timers: 0,
    });
  });
});
