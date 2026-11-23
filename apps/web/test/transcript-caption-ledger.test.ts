import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPTION_GAP_MARKER as GAP,
  TRANSCRIPTION_LINE_DEADLINE_MS as DEADLINE,
} from "../transcript-worker/src/constants";
import {
  AUDIO,
  OPENAI,
  SARVAM,
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
const ada = { userId: "ada", displayName: "Ada" };
const grace = { userId: "grace", displayName: "Grace" };
const speakers = (segments: { text: string; speakerUserId?: string }[]) =>
  segments.map(({ text, speakerUserId }) => [text, speakerUserId]);
const speechSent = (socket: { sent: Record<string, unknown>[] }) =>
  socket.sent.filter((message) => {
    const audio = (message as { audio?: unknown }).audio;
    return typeof audio === "string" ? audio === AUDIO.speech : Boolean((audio as { data?: string } | undefined)?.data);
  }).length;

describe("Neon C1: an unanswered Sarvam utterance never takes a later utterance's final", () => {
  it.each(["a false start on noise", "speech Sarvam never transcribes"] as const)(
    "after %s, the next speaker's final lands under that speaker",
    async (unanswered) => {
      vi.useFakeTimers();
      quiet();
      const { room, providerSockets, start, speak, sendAudio, endTurn } = await rig(SARVAM);
      await start("hi");
      const [socket] = providerSockets();
      await speak(ada);
      socket.emit(sarvamSpeechStart());
      await endTurn(ada);
      socket.emit(sarvamFinal("first", "First."));
      await vi.advanceTimersByTimeAsync(2_000);

      if (unanswered === "a false start on noise") await sendAudio("noise", ada);
      else await speak(ada);
      socket.emit(sarvamSpeechStart());
      await endTurn(ada);
      await vi.advanceTimersByTimeAsync(DEADLINE + 100);

      await speak(grace);
      socket.emit(sarvamSpeechStart());
      await endTurn(grace);
      socket.emit(sarvamFinal("ship", "Ship it Friday."));
      await vi.advanceTimersByTimeAsync(DEADLINE + 100);

      const expected = unanswered === "a false start on noise"
        ? [["First.", "ada"], ["Ship it Friday.", "grace"]]
        : [["First.", "ada"], [GAP, "ada"], ["Ship it Friday.", "grace"]];
      expect(speakers(room.segments)).toEqual(expected);
    },
  );
});

describe("Neon C3: finished or unowned Sarvam audio is never replayed", () => {
  it("a commit that arrives after the final does not keep the finished words for a replay", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, endTurn, savedTexts } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak(ada);
    socket.emit(sarvamFinal("hello", "Hello."));
    await settle();
    await endTurn(ada);

    socket.disconnect();
    await settle();
    expect(speechSent(providerSockets()[1])).toBe(0);
    expect(savedTexts()).toEqual(["Hello."]);
  });

  it("noise turns are never replayed", async () => {
    vi.useFakeTimers();
    const { providerSockets, start, sendAudio, endTurn } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    for (const kind of ["noise", "clicks", "silence"] as const) {
      await sendAudio(kind, ada);
      await endTurn(ada);
    }
    socket.disconnect();
    await settle();
    expect(providerSockets()[1].sent.filter((message) => (message as { audio?: unknown }).audio)).toHaveLength(0);
  });
});

describe("Neon C4 and H1: replayed lines are claimed by their own audio", () => {
  it("speech buffered while reconnecting never takes an older line's place or speaker", async () => {
    vi.useFakeTimers();
    quiet();
    const { room, providerSockets, connectPlans, start, speak, endTurn } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak(ada);
    socket.emit(sarvamSpeechStart());
    await endTurn(ada);

    connectPlans.push("unreachable");
    socket.disconnect();
    await settle();
    await speak(grace);
    await endTurn(grace);
    await vi.advanceTimersByTimeAsync(300);
    const replacement = providerSockets()[1];
    replacement.emit(sarvamSpeechStart());
    replacement.emit(sarvamSpeechStart());
    replacement.emit(sarvamFinal("a", "Ada's words."));
    replacement.emit(sarvamFinal("g", "Grace's words."));
    await settle();

    expect(speakers(room.segments)).toEqual([["Ada's words.", "ada"], ["Grace's words.", "grace"]]);
  });

  it("a speech signal that comes after the replay still binds the replayed line", async () => {
    vi.useFakeTimers();
    quiet();
    const { room, providerSockets, start, sendAudio, endTurn } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await sendAudio("softSpeech", ada);
    socket.emit(sarvamSpeechStart());
    await endTurn(ada);

    socket.disconnect();
    await settle();
    const replacement = providerSockets()[1];
    replacement.emit(sarvamSpeechStart());
    replacement.emit(sarvamFinal("a", "Quiet words."));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);

    expect(speakers(room.segments)).toEqual([["Quiet words.", "ada"]]);
  });

  it("a replacement that fails partway through a replay gives every line back for the next one", async () => {
    vi.useFakeTimers();
    quiet();
    const { room, providerSockets, connectPlans, start, speak, endTurn } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    for (const speaker of [ada, grace]) {
      await speak(speaker);
      socket.emit(sarvamSpeechStart());
      await endTurn(speaker);
    }

    connectPlans.push(2);
    socket.disconnect();
    await vi.advanceTimersByTimeAsync(300);
    const replacement = providerSockets().at(-1)!;
    expect(providerSockets()).toHaveLength(3);
    replacement.emit(sarvamFinal("a", "Ada first."));
    replacement.emit(sarvamFinal("g", "Grace second."));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);

    expect(speakers(room.segments)).toEqual([["Ada first.", "ada"], ["Grace second.", "grace"]]);
  });
});

describe("Neon H2: two utterances in one commit window each keep their own audio", () => {
  it("the first's final releases only its own audio, and the second still replays", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, endTurn, savedTexts } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak(ada);
    socket.emit(sarvamSpeechStart());
    socket.emit(sarvamFinal("first", "First."));
    await vi.advanceTimersByTimeAsync(2_000);

    await speak(ada);
    socket.emit(sarvamSpeechStart());
    await vi.advanceTimersByTimeAsync(200);
    await speak(ada);
    socket.emit(sarvamSpeechStart());
    socket.emit(sarvamFinal("one", "One."));
    await settle();
    await endTurn(ada);

    socket.disconnect();
    await settle();
    const replacement = providerSockets()[1];
    expect(speechSent(replacement)).toBe(1);
    replacement.emit(sarvamFinal("two", "Two."));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual(["First.", "One.", "Two."]);
  });
});

describe("Neon H3: committed or buffered speech is never lost without a trace", () => {
  it("an OpenAI commit not yet acknowledged shows as a gap after a restart and a takeover", async () => {
    vi.useFakeTimers();
    quiet();
    const { room, providerSockets, start, speak, commit, savedTexts, restartedTexts } = await rig(OPENAI);
    await start("en");
    const [socket] = providerSockets();
    await speak(ada);
    await commit(ada);
    expect(await restartedTexts()).toEqual([GAP]);

    socket.emit({ type: "error", error: { message: "Invalid API key provided." } });
    await settle();
    expect(room.session?.status).toBe("takeover_needed");
    expect(savedTexts()).toEqual([GAP]);
  });

  it("switching language while reconnecting sends the new provider every owed line and the buffered speech", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, connectPlans, start, switchTo, speak, commit, savedTexts } = await rig(OPENAI);
    await start("en");
    const [socket] = providerSockets();
    await speak(ada);
    await commit(ada);
    socket.emit(openAiCommitted("a"));
    await settle();

    connectPlans.push("unreachable");
    socket.disconnect();
    await settle();
    await speak(grace);
    await commit(grace);
    await switchTo("fr");
    const french = providerSockets().at(-1)!;
    expect(french.sentTypes().filter((type) => type === "input_audio_buffer.commit")).toHaveLength(2);
    french.emit(openAiCommitted("fr_a"));
    french.emit(openAiCommitted("fr_g"));
    french.emit(openAiFinal("fr_g", "Grace in French."));
    french.emit(openAiFinal("fr_a", "Ada in French."));
    await settle();

    expect(savedTexts()).toEqual(["Ada in French.", "Grace in French."]);
  });

  it("audio sent while a switch saves the session goes to the new provider", async () => {
    vi.useFakeTimers();
    const { room, providerSockets, start, switchTo, speak, commit, savedTexts } = await rig(OPENAI);
    await start("en");
    const storage = (room as unknown as { state: { storage: { put: (key: string, value: unknown) => Promise<void> } } }).state.storage;
    const put = storage.put.bind(storage);
    let release: () => void = () => {};
    storage.put = (key, value) => {
      storage.put = put;
      return new Promise<void>((resolve) => {
        release = () => void put(key, value).then(resolve);
      });
    };
    const switching = switchTo("hi");
    await settle();
    await speak(ada);
    await commit(ada);
    release();
    await switching;
    await settle();
    const hindi = providerSockets().at(-1)!;
    expect(hindi.sentTypes()).toContain("input_audio_buffer.commit");
    hindi.emit(openAiCommitted("hi_1"));
    hindi.emit(openAiFinal("hi_1", "Said during the switch."));
    await settle();
    expect(savedTexts()).toEqual(["Said during the switch."]);
  });

  it("Sarvam: a second speaker without a turn end still gets a line of their own", async () => {
    vi.useFakeTimers();
    quiet();
    const { room, providerSockets, start, speak, endTurn } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak(ada);
    await speak(grace);
    await endTurn(grace);
    socket.emit(sarvamFinal("a", "Ada speaks."));
    socket.emit(sarvamFinal("g", "Grace answers."));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);

    expect(speakers(room.segments)).toEqual([["Ada speaks.", "ada"], ["Grace answers.", "grace"]]);
  });

  it("Sarvam: soft speech our check hears ends as a gap when Sarvam never answers", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, sendAudio, endTurn, savedTexts } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak(ada);
    socket.emit(sarvamSpeechStart());
    socket.emit(sarvamFinal("first", "First."));
    await endTurn(ada);
    await vi.advanceTimersByTimeAsync(2_000);

    await sendAudio("softSpeech", ada);
    socket.emit(sarvamSpeechStart());
    await endTurn(ada);
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual(["First.", GAP]);
  });
});

describe("Neon H4: one OpenAI item failing ends only that line", () => {
  it("the live session stays up and the other line still finishes", async () => {
    vi.useFakeTimers();
    quiet();
    const { room, providerSockets, start, speak, commit, savedTexts } = await rig(OPENAI);
    await start("en");
    const [socket] = providerSockets();
    for (const itemId of ["bad", "good"]) {
      await speak(ada);
      await commit(ada);
      socket.emit(openAiCommitted(itemId));
    }
    socket.emit({
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "bad",
      error: { message: "This item could not be transcribed" },
    });
    socket.emit(openAiFinal("good", "Good line."));
    await settle();

    expect(room.session?.status).toBe("live");
    expect(socket.closed).toBe(false);
    expect(savedTexts()).toEqual([GAP, "Good line."]);
  });
});

describe("Neon H5: every Sarvam line takes the speaker of its own audio", () => {
  it("a speech signal that came before the speaker's audio was heard takes that speaker once it is", async () => {
    vi.useFakeTimers();
    quiet();
    const { room, providerSockets, start, speak, endTurn } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak(ada);
    socket.emit(sarvamSpeechStart());
    socket.emit(sarvamFinal("a", "Ada first."));
    await endTurn(ada);
    await vi.advanceTimersByTimeAsync(2_000);

    socket.emit(sarvamSpeechStart());
    await vi.advanceTimersByTimeAsync(200);
    await speak(grace);
    await endTurn(grace);
    await vi.advanceTimersByTimeAsync(1_700);
    socket.emit(sarvamFinal("g", "Grace next."));
    await settle();

    expect(speakers(room.segments)).toEqual([["Ada first.", "ada"], ["Grace next.", "grace"]]);
  });

  it("a speaker who interrupts within the hangover gets their own line", async () => {
    vi.useFakeTimers();
    const { room, providerSockets, start, speak, endTurn } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak(ada);
    socket.emit(sarvamSpeechStart());
    await vi.advanceTimersByTimeAsync(250);
    await speak(grace);
    socket.emit(sarvamSpeechStart());
    await endTurn(grace);
    socket.emit(sarvamFinal("a", "Ada starts."));
    socket.emit(sarvamFinal("g", "Grace interrupts."));
    await settle();

    expect(speakers(room.segments)).toEqual([["Ada starts.", "ada"], ["Grace interrupts.", "grace"]]);
  });

  it("a speech signal later than the lookback still takes the speaker whose speech it was", async () => {
    vi.useFakeTimers();
    const { room, providerSockets, start, speak, sendAudio, endTurn } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak(ada);
    socket.emit(sarvamSpeechStart());
    socket.emit(sarvamFinal("first", "First."));
    await endTurn(ada);
    await vi.advanceTimersByTimeAsync(2_000);

    await speak(ada);
    await endTurn(ada);
    await vi.advanceTimersByTimeAsync(1_600);
    await sendAudio("noise", grace);
    await vi.advanceTimersByTimeAsync(100);
    socket.emit(sarvamSpeechStart());
    socket.emit(sarvamFinal("late", "Ada again."));
    await settle();

    expect(speakers(room.segments)).toEqual([["First.", "ada"], ["Ada again.", "ada"]]);
  });
});

describe("Neon M: nothing a line or a replaced provider held outlives it", () => {
  it("M1: stopping notes leaves nothing behind, and a closed connection forgets its ended lines", async () => {
    vi.useFakeTimers();
    quiet();
    const { room, providerSockets, start, switchTo, speak, commit, stop, retainedLineState } = await rig(OPENAI);
    await start("en");
    const [socket] = providerSockets();
    await speak(ada);
    await commit(ada);
    socket.emit(openAiCommitted("a"));
    socket.emit(openAiFinal("a", "Done."));
    await switchTo("hi");
    await settle();
    expect(socket.closed).toBe(true);
    expect((room as unknown as { ledger: { size: number } }).ledger.size).toBe(0);

    await stop();
    expect(retainedLineState()).toEqual({ lines: 0, connections: 0, unownedAudio: 0, bufferedAudio: 0, timers: 0 });
  });

  it("M2: a replaced provider's lines let their replay audio go", async () => {
    vi.useFakeTimers();
    const { room, providerSockets, start, switchTo, speak, commit } = await rig(OPENAI);
    await start("en");
    const [socket] = providerSockets();
    await speak(ada);
    await commit(ada);
    socket.emit(openAiCommitted("a"));
    await switchTo("hi");
    const lines = (room as unknown as { ledger: { all(): { audio: unknown[] }[] } }).ledger.all();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every(({ audio }) => audio.length === 0)).toBe(true);
  });

  it("M3: a takeover closes replaced providers and ends their lines", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, switchTo, speak, commit, savedTexts } = await rig(OPENAI);
    await start("en");
    const [english] = providerSockets();
    await speak(ada);
    await commit(ada);
    english.emit(openAiCommitted("a"));
    await switchTo("hi");
    const hindi = providerSockets()[1];
    hindi.emit({ type: "error", error: { message: "Invalid API key provided." } });
    await settle();

    expect(english.closed).toBe(true);
    expect(savedTexts()).toEqual([GAP]);
  });

  it("M4: a restore that loses to a host's new session never fails that session", async () => {
    vi.useFakeTimers();
    quiet();
    const { room } = await transcriptRoomRig(lookup, OPENAI, { OPENAI_API_KEY: "sk-global" });
    const internals = room as unknown as {
      session: { status: string } | null;
      sessionRevision: number;
      restorePersistedGlobalSession(snapshot: object): Promise<void>;
      closeTranscriptionProvider(keepOwed: boolean): void;
    };
    let release: () => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((resolve) => {
        release = () => resolve({ webSocket: null, status: 503 });
      })),
    );
    const restoring = internals.restorePersistedGlobalSession({
      session: {
        roomId: "room",
        status: "live",
        controller: null,
        transcriptModel: OPENAI,
        qaModel: "gpt-6.1-sol",
        transportMode: "browser",
        keySource: "global",
        startedAt: Date.now(),
        updatedAt: Date.now(),
        error: null,
      },
      segments: [],
      sequence: 0,
    });
    await settle();
    internals.sessionRevision += 1;
    internals.closeTranscriptionProvider(true);
    internals.session = { ...internals.session!, status: "starting" };
    release();
    await restoring;

    expect(internals.session?.status).toBe("starting");
  });

  it("M5: a replayed line keeps the words it showed until the replacement sends its own", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, commit, savedTexts } = await rig(OPENAI);
    await start("en");
    const [socket] = providerSockets();
    await speak(ada);
    await commit(ada);
    socket.emit(openAiCommitted("a"));
    socket.emit(openAiDelta("a", "Words of a"));
    await settle();

    socket.disconnect();
    await settle();
    providerSockets()[1].emit(openAiCommitted("a2"));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual(["Words of a"]);
  });

  it("M5: the replacement's own words replace the old ones instead of adding to them", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, commit, savedTexts, viewerTranscript } = await rig(OPENAI);
    await start("en");
    const [socket] = providerSockets();
    await speak(ada);
    await commit(ada);
    socket.emit(openAiCommitted("a"));
    socket.emit(openAiDelta("a", "Words of a"));
    await settle();

    socket.disconnect();
    await settle();
    const replacement = providerSockets()[1];
    replacement.emit(openAiCommitted("a2"));
    replacement.emit(openAiDelta("a2", "Fresh words"));
    await settle();
    expect([...viewerTranscript().partials.values()].map(({ text }) => text)).toEqual(["Fresh words"]);
    replacement.emit(openAiFinal("a2", "Fresh words, done."));
    await settle();
    expect(savedTexts()).toEqual(["Fresh words, done."]);
  });

  it("M6: a live reconnect keeps a replaced provider's words on viewers' screens", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, switchTo, speak, commit, viewerTranscript } = await rig(OPENAI);
    await start("en");
    const [english] = providerSockets();
    await speak(ada);
    await commit(ada);
    english.emit(openAiCommitted("a"));
    english.emit(openAiDelta("a", "Still draining"));
    await switchTo("hi");
    const hindi = providerSockets()[1];
    await speak(grace);
    await commit(grace);
    hindi.emit(openAiCommitted("h"));
    hindi.emit(openAiDelta("h", "Live words"));
    await settle();

    hindi.disconnect();
    await settle();
    expect([...viewerTranscript().partials.values()].map(({ text }) => text)).toEqual(["Still draining", "Live words"]);
  });
});
