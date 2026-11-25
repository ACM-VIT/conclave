import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SARVAM_WINDOW_SETTLE_MS as SETTLE,
  TRANSCRIPTION_GAP_MARKER as GAP,
  TRANSCRIPTION_LINE_DEADLINE_MS as DEADLINE,
} from "../transcript-worker/src/constants";
import {
  OPENAI,
  SARVAM,
  answerSarvamReplays,
  openAiCommitted,
  openAiDelta,
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
    await vi.advanceTimersByTimeAsync(600);

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
    await vi.advanceTimersByTimeAsync(SETTLE + 100);
    expect(await restartedTexts()).toEqual([GAP]);

    socket.emit(sarvamSpeechStart());
    socket.emit(sarvamFinal("spoken", "Spoken."));
    await vi.advanceTimersByTimeAsync(SETTLE);
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
    await vi.advanceTimersByTimeAsync(600);

    expect(savedTexts()).toEqual(["One. Two."]);
    expect(before.closed).toBe(true);
  });

  it("Sarvam: an utterance that never gets its final ends as a gap and replaces its speaker's connection, live and after a switch", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, switchTo, speak, endTurn, savedTexts } = await rig(SARVAM);
    await start("hi");
    const [first] = providerSockets();
    await speak();
    await endTurn();
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual([GAP]);
    expect(first.closed).toBe(true);

    await speak();
    await endTurn();
    await settle();
    const before = providerSockets().at(-1)!;
    expect(before).not.toBe(first);
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
    await vi.advanceTimersByTimeAsync(SETTLE + 500);

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
    await vi.advanceTimersByTimeAsync(SETTLE + 500);

    await sendAudio("noise");
    await endTurn();
    socket.emit(sarvamSpeechStart());
    await vi.advanceTimersByTimeAsync(400);
    await speak();
    socket.emit(sarvamFinal("two", ""));
    await vi.advanceTimersByTimeAsync(SETTLE);
    socket.emit(sarvamSpeechStart());
    await endTurn();
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
    await vi.advanceTimersByTimeAsync(SETTLE + 500);

    await sendAudio("noise");
    await endTurn();
    socket.emit(sarvamSpeechStart());
    await speak();
    socket.emit(sarvamFinal("two", ""));
    for (const _ of [1, 2, 3, 4, 5, 6]) {
      await vi.advanceTimersByTimeAsync(250);
      await speak();
    }
    await vi.advanceTimersByTimeAsync(SETTLE);
    socket.emit(sarvamSpeechStart());
    await endTurn();
    await vi.advanceTimersByTimeAsync(1_600);
    expect(await restartedTexts()).toEqual(["First.", GAP]);

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
    await vi.advanceTimersByTimeAsync(SETTLE + 500);

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
    await vi.advanceTimersByTimeAsync(SETTLE + 500);

    socket.emit(sarvamSpeechStart());
    expect(await restartedTexts()).toEqual(["First."]);
    await vi.advanceTimersByTimeAsync(250);
    await speak();
    await endTurn();
    expect(await restartedTexts()).toEqual(["First.", GAP]);
    await vi.advanceTimersByTimeAsync(1_600);
    expect(await restartedTexts()).toEqual(["First.", GAP]);
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual(["First.", GAP]);
  });
});

describe("a line's state lives on its record", () => {
  const ada = { userId: "ada", displayName: "Ada" };
  const guest = { userId: "guest", displayName: "Guest" };

  it("Sarvam: a line's deadline closes only its own connection, so the speaker's next turn still goes out and gets its answer", async () => {
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
    expect([savedTexts(), socket.closed]).toEqual([[GAP], true]);

    const replacement = providerSockets()[1];
    const replayed = replacement.sent.filter((message) => (message as { audio?: unknown }).audio).length;
    expect(replayed).toBe(1);
    replacement.emit(sarvamFinal("b", "Second line."));
    await vi.advanceTimersByTimeAsync(SETTLE);
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

  it("Sarvam: words answered before a reconnect are replayed with their turn, so they show once", async () => {
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
    expect(replacement.sent.filter((message) => (message as { audio?: unknown }).audio)).toHaveLength(1);
    replacement.emit(sarvamFinal("again", "Already captioned."));
    await endTurn(ada);
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);

    expect(savedTexts()).toEqual(["Already captioned."]);
    expect(viewerTranscript().segments.map(({ text }) => text)).toEqual(["Already captioned."]);
  });

  it("OpenAI: a replayed line that became a gap before the replacement's final came is corrected under the same itemId", async () => {
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
    replacement.emit(openAiCommitted("a2"));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual([GAP]);
    const gapId = room.segments[0]!.itemId;
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
    const harness = await rig(SARVAM);
    const { providerSockets, start, speak, endTurn, room, viewerTranscript } = harness;
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
    (await harness.lane(grace)).emit(sarvamSpeechStart());
    await settle();

    socket.disconnect();
    await settle();
    await answerSarvamReplays(harness, [
      [ada, "a", "Ada again."],
      [grace, "g", "Grace now."],
    ]);

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
    const { providerSockets, lane, start, speak, endTurn, savedTexts } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak(ada);
    socket.emit(sarvamSpeechStart());
    socket.emit(sarvamFinal("first", "First."));
    await endTurn(ada);
    await vi.advanceTimersByTimeAsync(SETTLE + 500);

    await speak(ada);
    socket.emit(sarvamSpeechStart());
    await vi.advanceTimersByTimeAsync(300);
    await speak(grace);
    await endTurn(grace);
    await vi.advanceTimersByTimeAsync(700);
    (await lane(grace)).emit(sarvamSpeechStart());
    socket.emit(sarvamFinal("second", "Second."));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);

    expect(savedTexts()).toEqual(["First.", "Second.", GAP]);
  });
});
