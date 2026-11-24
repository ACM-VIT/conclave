import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPTION_COMMIT_ACK_TIMEOUT_MS as COMMIT_ACK_TIMEOUT,
  TRANSCRIPTION_GAP_MARKER as GAP,
  TRANSCRIPTION_LINE_DEADLINE_MS as DEADLINE,
  TRANSCRIPTION_RECOVERY_MAX_AUDIO_BYTES as REPLAY_AUDIO_LIMIT,
} from "../transcript-worker/src/constants";
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

  it("speech no signal claimed in time is never replayed into a gap", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, endTurn, savedTexts } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak(ada);
    socket.emit(sarvamSpeechStart());
    await endTurn(ada);
    socket.emit(sarvamFinal("one", "First."));
    await vi.advanceTimersByTimeAsync(2_000);

    await speak(grace);
    await endTurn(grace);
    await vi.advanceTimersByTimeAsync(5_000);
    socket.disconnect();
    await settle();

    expect(speechSent(providerSockets().at(-1)!)).toBe(0);
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual(["First."]);
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

  it("audio sent while a switch saves the session is captioned by the provider still running", async () => {
    vi.useFakeTimers();
    const { room, providerSockets, start, switchTo, speak, commit, savedTexts } = await rig(OPENAI);
    await start("en");
    const [english] = providerSockets();
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
    expect(english.sentTypes()).toContain("input_audio_buffer.commit");
    english.emit(openAiCommitted("en_1"));
    release();
    await switching;
    await settle();
    expect(providerSockets().at(-1)).not.toBe(english);
    english.emit(openAiFinal("en_1", "Said during the switch."));
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

describe("Sarvam: a line heard after its speech signal owns that speech", () => {
  const signalBeforeSpeech = async () => {
    const harness = await rig(SARVAM);
    await harness.start("hi");
    const [socket] = harness.providerSockets();
    await harness.speak(ada);
    socket.emit(sarvamSpeechStart());
    await harness.endTurn(ada);
    socket.emit(sarvamFinal("one", "First."));
    await vi.advanceTimersByTimeAsync(2_000);

    socket.emit(sarvamSpeechStart());
    await vi.advanceTimersByTimeAsync(250);
    await harness.speak(grace);
    await harness.endTurn(grace);
    await vi.advanceTimersByTimeAsync(1_600);
    return { ...harness, socket };
  };

  it("a reconnect replays it as that one line, with no gap beside it", async () => {
    vi.useFakeTimers();
    quiet();
    const { room, providerSockets, socket } = await signalBeforeSpeech();

    socket.disconnect();
    await settle();
    const replacement = providerSockets().at(-1)!;
    replacement.emit(sarvamSpeechStart());
    replacement.emit(sarvamFinal("two", "Second."));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);

    expect(speakers(room.segments)).toEqual([["First.", "ada"], ["Second.", "grace"]]);
  });

  it("its final lets that speech go, so a reconnect never replays it into a second caption", async () => {
    vi.useFakeTimers();
    quiet();
    const { room, providerSockets, socket, retainedLineState } = await signalBeforeSpeech();
    socket.emit(sarvamFinal("two", "Second."));
    await settle();
    expect(retainedLineState().unownedAudio).toBe(0);

    socket.disconnect();
    await settle();
    expect(speechSent(providerSockets().at(-1)!)).toBe(0);
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(speakers(room.segments)).toEqual([["First.", "ada"], ["Second.", "grace"]]);
  });
});

describe("Sarvam: a final that comes before our check resolved its signal", () => {
  it("takes the speech heard after its signal, with its speaker, so a reconnect never replays it", async () => {
    vi.useFakeTimers();
    quiet();
    const { room, providerSockets, start, speak, endTurn, retainedLineState } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak(ada);
    socket.emit(sarvamSpeechStart());
    await endTurn(ada);
    socket.emit(sarvamFinal("one", "First."));
    await vi.advanceTimersByTimeAsync(2_000);

    socket.emit(sarvamSpeechStart());
    await vi.advanceTimersByTimeAsync(250);
    await speak(grace);
    await endTurn(grace);
    await vi.advanceTimersByTimeAsync(300);
    socket.emit(sarvamFinal("two", "Yes."));
    await settle();
    expect(retainedLineState().unownedAudio).toBe(0);

    socket.disconnect();
    await settle();
    expect(speechSent(providerSockets().at(-1)!)).toBe(0);
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(speakers(room.segments)).toEqual([["First.", "ada"], ["Yes.", "grace"]]);
  });
});

describe("Sarvam: a line waits while its speaker is still talking", () => {
  it.each([
    ["after Sarvam has signalled speech", true],
    ["before Sarvam has signalled anything", false],
  ])("speech longer than the deadline still ends as one caption, %s", async (_, signals) => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, endTurn, savedTexts } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    if (signals) {
      await speak(grace);
      socket.emit(sarvamSpeechStart());
      await endTurn(grace);
      socket.emit(sarvamFinal("one", "First."));
      await vi.advanceTimersByTimeAsync(2_000);
    }

    await speak(ada);
    if (signals) socket.emit(sarvamSpeechStart());
    for (let elapsed = 0; elapsed < DEADLINE + 5_000; elapsed += 250) {
      await vi.advanceTimersByTimeAsync(250);
      await speak(ada);
    }
    await endTurn(ada);
    socket.emit(sarvamFinal("long", "A long thought."));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);

    expect(savedTexts()).toEqual([...(signals ? ["First."] : []), "A long thought."]);
  });
});

describe("Sarvam: a line's wait follows its own audio", () => {
  it("a second utterance in the same turn takes its audio's wait with it, so the first still ends on time", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, endTurn, savedTexts } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak(ada);
    socket.emit(sarvamSpeechStart());
    await vi.advanceTimersByTimeAsync(700);
    await speak(ada);
    socket.emit(sarvamSpeechStart());
    await endTurn(ada);

    await vi.advanceTimersByTimeAsync(DEADLINE - 700 + 100);
    socket.emit(sarvamFinal("two", "Second."));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);

    expect(savedTexts()).toEqual([GAP, GAP]);
  });
});

describe("Sarvam: a replayed line is claimed once", () => {
  it("speech our check missed in the next replayed line binds that line, not one already claimed", async () => {
    vi.useFakeTimers();
    quiet();
    const { room, providerSockets, connectPlans, start, switchTo, useModel, speak, sendAudio, commit } = await rig(OPENAI);
    await start("en");
    const [socket] = providerSockets();
    await speak(ada);
    await speak(ada);
    await commit(ada);
    await sendAudio("whisper", grace);
    await commit(grace);
    socket.emit(openAiCommitted("a"));
    socket.emit(openAiCommitted("g"));
    socket.emit(openAiDelta("g", "Grace so far"));
    await settle();

    connectPlans.push("unreachable");
    socket.disconnect();
    await settle();
    useModel(SARVAM);
    await switchTo("hi");
    const sarvam = providerSockets().at(-1)!;
    sarvam.emit(sarvamSpeechStart());
    sarvam.emit(sarvamSpeechStart());
    sarvam.emit(sarvamFinal("1", "Ada in Hindi."));
    sarvam.emit(sarvamFinal("2", "Grace in Hindi."));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);

    expect(speakers(room.segments)).toEqual([["Ada in Hindi.", "ada"], ["Grace in Hindi.", "grace"]]);
  });
});

describe("Sarvam: speech evidence belongs to its own turn", () => {
  it("two turns that start in the same millisecond each keep their own speech", async () => {
    vi.useFakeTimers();
    quiet();
    const { room, providerSockets, start, speak, endTurn } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak(ada);
    socket.emit(sarvamSpeechStart());
    await endTurn(ada);
    socket.emit(sarvamFinal("one", "First."));
    await vi.advanceTimersByTimeAsync(2_000);

    await speak(ada);
    await endTurn(ada);
    await speak(grace);
    await endTurn(grace);
    socket.emit(sarvamSpeechStart());
    socket.emit(sarvamSpeechStart());
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);

    expect(speakers(room.segments)).toEqual([["First.", "ada"], [GAP, "ada"], [GAP, "grace"]]);
  });

  it("two turns before a delayed speech signal each keep their own audio, so the first final leaves the second's to replay", async () => {
    vi.useFakeTimers();
    quiet();
    const { room, providerSockets, start, speak, endTurn } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak(grace);
    socket.emit(sarvamSpeechStart());
    await endTurn(grace);
    socket.emit(sarvamFinal("zero", "First."));
    await vi.advanceTimersByTimeAsync(2_000);

    await speak(ada);
    await endTurn(ada);
    await vi.advanceTimersByTimeAsync(300);
    await speak(ada);
    await endTurn(ada);
    await vi.advanceTimersByTimeAsync(400);
    socket.emit(sarvamSpeechStart());
    socket.emit(sarvamSpeechStart());
    socket.emit(sarvamFinal("one", "Ada one."));
    await settle();

    socket.disconnect();
    await settle();
    const replacement = providerSockets().at(-1)!;
    expect(speechSent(replacement)).toBe(1);
    replacement.emit(sarvamSpeechStart());
    replacement.emit(sarvamFinal("two", "Ada two."));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(speakers(room.segments)).toEqual([["First.", "grace"], ["Ada one.", "ada"], ["Ada two.", "ada"]]);
  });

  it("an end-of-speech signal that comes after the next turn's audio leaves that turn its speech", async () => {
    vi.useFakeTimers();
    quiet();
    const { room, providerSockets, start, speak, endTurn } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak(ada);
    socket.emit(sarvamSpeechStart());
    await endTurn(ada);
    await vi.advanceTimersByTimeAsync(300);
    await speak(grace);
    await endTurn(grace);
    socket.emit(sarvamSpeechEnd());
    socket.emit(sarvamFinal("one", "First."));
    socket.emit(sarvamSpeechStart());
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);

    expect(speakers(room.segments)).toEqual([["First.", "ada"], [GAP, "grace"]]);
  });
});

describe("OpenAI: a commit's line keeps its own deadline and watchdog", () => {
  it("a commit no connection acknowledges, even after its replay, ends as a gap", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, commit, savedTexts } = await rig(OPENAI);
    await start("en");
    await speak(ada);
    await commit(ada);
    await vi.advanceTimersByTimeAsync(COMMIT_ACK_TIMEOUT + 100);
    expect(providerSockets()).toHaveLength(2);
    expect(savedTexts()).toEqual([]);

    await vi.advanceTimersByTimeAsync(COMMIT_ACK_TIMEOUT + 100);
    expect(savedTexts()).toEqual([GAP]);
    expect(providerSockets().at(-1)!.sentTypes()).not.toContain("input_audio_buffer.commit");
  });

  it("trimming finished lines never stops the watchdog that reconnects a provider that stopped acknowledging", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, commit, savedTexts } = await transcriptRoomRig(lookup, OPENAI, {
      TRANSCRIPT_MAX_SEGMENTS: "1",
    });
    await start("en");
    const [socket] = providerSockets();
    for (const [itemId, words] of [["a", "Ada."], ["b", "Bea."]]) {
      await speak(ada);
      await commit(ada);
      socket.emit(openAiCommitted(itemId));
      socket.emit(openAiFinal(itemId, words));
    }
    await speak(grace);
    await commit(grace);
    await settle();
    expect(savedTexts()).toEqual(["Bea."]);

    await vi.advanceTimersByTimeAsync(COMMIT_ACK_TIMEOUT + 100);
    expect(providerSockets()).toHaveLength(2);
  });

  it("late answers for trimmed lines show nothing and never take a later line's commit", async () => {
    vi.useFakeTimers();
    quiet();
    const { room, providerSockets, start, speak, commit, broadcastFinals } = await transcriptRoomRig(lookup, OPENAI, {
      TRANSCRIPT_MAX_SEGMENTS: "1",
    });
    await start("en");
    const [socket] = providerSockets();
    for (const [itemId, speaker] of [["a", ada], ["g", grace], ["h", ada]] as const) {
      await speak(speaker);
      await commit(speaker);
      socket.emit(openAiCommitted(itemId));
    }
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    await speak(grace);
    await commit(grace);

    socket.emit(openAiFinal("a", "Ada, late."));
    socket.emit(openAiFinal("g", "Grace, late."));
    socket.emit(openAiCommitted("x"));
    socket.emit(openAiFinal("x", "Grace again."));
    await settle();

    expect(broadcastFinals()).not.toContain("Ada, late.");
    expect(broadcastFinals()).not.toContain("Grace, late.");
    expect(speakers(room.segments)).toEqual([["Grace again.", "grace"]]);
  });
});

describe("replay audio stays within one shared limit", () => {
  it("a relay that never commits keeps only the newest audio, up to the limit", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, retainedAudioBytes } = await rig(OPENAI);
    await start("en");
    const [socket] = providerSockets();
    const chunks = Math.ceil((1.25 * REPLAY_AUDIO_LIMIT) / AUDIO.speech.length);
    for (let index = 0; index < chunks; index += 1) {
      await speak(ada);
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(retainedAudioBytes()).toBeLessThanOrEqual(REPLAY_AUDIO_LIMIT);
    expect(retainedAudioBytes()).toBeGreaterThan(REPLAY_AUDIO_LIMIT - AUDIO.speech.length);

    socket.disconnect();
    await settle();
    const replayed = speechSent(providerSockets().at(-1)!);
    expect(replayed * AUDIO.speech.length).toBeLessThanOrEqual(REPLAY_AUDIO_LIMIT);
    expect(replayed).toBeGreaterThan(0);
  });
});

describe("Sol: one line model across connections", () => {
  it("OpenAI: an unacknowledged commit keeps its audio for the watchdog's replay, and shows nothing until something answers it", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, commit, savedTexts, viewerTranscript } = await rig(OPENAI);
    await start("en");
    await speak(ada);
    await commit(ada);
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual([]);

    await vi.advanceTimersByTimeAsync(COMMIT_ACK_TIMEOUT - DEADLINE);
    const replacement = providerSockets().at(-1)!;
    expect(providerSockets()).toHaveLength(2);
    expect(replacement.sentTypes().filter((type) => type === "input_audio_buffer.commit")).toHaveLength(1);
    replacement.emit(openAiCommitted("r"));
    replacement.emit(openAiFinal("r", "Recovered."));
    await settle();

    expect(savedTexts()).toEqual(["Recovered."]);
    expect(viewerTranscript().segments.map(({ text }) => text)).toEqual(["Recovered."]);
  });

  it("Sarvam: replayed lines are answered in the order they were sent, whatever our check hears in them", async () => {
    vi.useFakeTimers();
    quiet();
    const { room, providerSockets, connectPlans, start, switchTo, useModel, speak, sendAudio, commit } = await rig(OPENAI);
    await start("en");
    const [socket] = providerSockets();
    await sendAudio("whisper", ada);
    await commit(ada);
    socket.emit(openAiCommitted("a"));
    socket.emit(openAiDelta("a", "Ada so far"));
    await speak(grace);
    await commit(grace);
    socket.emit(openAiCommitted("g"));
    await settle();

    connectPlans.push("unreachable");
    socket.disconnect();
    await settle();
    useModel(SARVAM);
    await switchTo("hi");
    const sarvam = providerSockets().at(-1)!;
    sarvam.emit(sarvamSpeechStart());
    sarvam.emit(sarvamSpeechEnd());
    sarvam.emit(sarvamFinal("1", "Ada in Hindi."));
    sarvam.emit(sarvamSpeechStart());
    sarvam.emit(sarvamSpeechEnd());
    sarvam.emit(sarvamFinal("2", "Grace in Hindi."));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);

    expect(speakers(room.segments)).toEqual([["Ada in Hindi.", "ada"], ["Grace in Hindi.", "grace"]]);
  });

  it("Sarvam: a final with no end-of-speech signal takes the rest of its speech, so the next signal keeps its own speaker", async () => {
    vi.useFakeTimers();
    quiet();
    const { room, providerSockets, start, speak, endTurn } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak(grace);
    socket.emit(sarvamSpeechStart());
    socket.emit(sarvamSpeechEnd());
    socket.emit(sarvamFinal("setup", "Setup."));
    await endTurn(grace);
    await vi.advanceTimersByTimeAsync(2_000);

    await speak(ada);
    socket.emit(sarvamSpeechStart());
    await vi.advanceTimersByTimeAsync(200);
    await speak(ada);
    socket.emit(sarvamFinal("early", "Already final."));
    await endTurn(ada);
    await speak(grace);
    socket.emit(sarvamSpeechStart());
    await endTurn(grace);
    socket.emit(sarvamSpeechEnd());
    socket.emit(sarvamFinal("grace", "Grace owns this."));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);

    expect(speakers(room.segments)).toEqual([
      ["Setup.", "grace"],
      ["Already final.", "ada"],
      ["Grace owns this.", "grace"],
    ]);
  });

  it("owed lines and audio buffered while reconnecting share one limit", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, connectPlans, start, speak, commit, heldAudioBytes } = await rig(OPENAI);
    await start("en");
    const [socket] = providerSockets();
    const chunks = Math.ceil((0.6 * REPLAY_AUDIO_LIMIT) / AUDIO.speech.length);
    for (let index = 0; index < chunks; index += 1) {
      await speak(ada);
      await vi.advanceTimersByTimeAsync(20);
    }
    await commit(ada);
    socket.emit(openAiCommitted("a"));
    connectPlans.push(...Array<"unreachable">(30).fill("unreachable"));
    socket.disconnect();
    await settle();
    for (let index = 0; index < chunks; index += 1) {
      await speak(grace);
      await vi.advanceTimersByTimeAsync(20);
    }

    expect(heldAudioBytes()).toBeLessThanOrEqual(REPLAY_AUDIO_LIMIT);
    expect(heldAudioBytes()).toBeGreaterThan(REPLAY_AUDIO_LIMIT - AUDIO.speech.length);
  });

  it("a line its provider ends with an empty final is let go at once", async () => {
    vi.useFakeTimers();
    const { providerSockets, start, sendAudio, commit, savedTexts, retainedLineState } = await rig(OPENAI);
    await start("en");
    const [socket] = providerSockets();
    for (let index = 0; index < 50; index += 1) {
      await sendAudio("silence", ada);
      await commit(ada);
      socket.emit(openAiCommitted(`i${index}`));
      socket.emit(openAiFinal(`i${index}`, ""));
      await vi.advanceTimersByTimeAsync(1_000);
    }

    expect(savedTexts()).toEqual([]);
    expect(retainedLineState().lines).toBe(0);
  });
});

describe("Sarvam: an utterance's speech runs from its signal to the next onset in its turn", () => {
  it("a final that comes first takes only its own speech, so the next utterance in the turn still replays", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, sendAudio, endTurn, savedTexts } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak(ada);
    socket.emit(sarvamSpeechStart());
    await endTurn(ada);
    socket.emit(sarvamFinal("zero", "First."));
    await vi.advanceTimersByTimeAsync(2_000);

    socket.emit(sarvamSpeechStart());
    await vi.advanceTimersByTimeAsync(100);
    await speak(grace);
    for (const _ of [1, 2, 3, 4]) {
      await vi.advanceTimersByTimeAsync(200);
      await sendAudio("silence", grace);
    }
    await vi.advanceTimersByTimeAsync(200);
    await speak(grace);
    socket.emit(sarvamFinal("one", "Grace one."));
    await settle();

    socket.disconnect();
    await settle();
    const replacement = providerSockets().at(-1)!;
    expect(speechSent(replacement)).toBe(1);
    replacement.emit(sarvamSpeechStart());
    replacement.emit(sarvamFinal("two", "Grace two."));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual(["First.", "Grace one.", "Grace two."]);
  });

  const secondUtteranceInTurn = async () => {
    const harness = await rig(SARVAM);
    await harness.start("hi");
    const [socket] = harness.providerSockets();
    await harness.speak(ada);
    socket.emit(sarvamSpeechStart());
    await harness.endTurn(ada);
    socket.emit(sarvamFinal("zero", "First."));
    await vi.advanceTimersByTimeAsync(2_000);

    await harness.speak(grace);
    socket.emit(sarvamSpeechStart());
    for (const _ of [1, 2, 3, 4]) {
      await vi.advanceTimersByTimeAsync(200);
      await harness.sendAudio("silence", grace);
    }
    await vi.advanceTimersByTimeAsync(200);
    await harness.speak(grace);
    socket.emit(sarvamFinal("one", "Grace one."));
    await vi.advanceTimersByTimeAsync(300);
    socket.emit(sarvamSpeechStart());
    await settle();
    return { ...harness, socket };
  };

  it("the next utterance's speech stays its own when the one before it ends, so its late signal still hears it", async () => {
    vi.useFakeTimers();
    quiet();
    const { savedTexts } = await secondUtteranceInTurn();
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual(["First.", "Grace one.", GAP]);
  });

  it("an end-of-speech signal for a late signal takes only its own speech, so the next utterance's signal takes the rest", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, start, speak, sendAudio, endTurn, savedTexts } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    await speak(ada);
    socket.emit(sarvamSpeechStart());
    await endTurn(ada);
    socket.emit(sarvamFinal("zero", "First."));
    await vi.advanceTimersByTimeAsync(2_000);

    await sendAudio("silence", grace);
    socket.emit(sarvamSpeechStart());
    await vi.advanceTimersByTimeAsync(100);
    await speak(grace);
    for (const _ of [1, 2, 3, 4]) {
      await vi.advanceTimersByTimeAsync(200);
      await sendAudio("silence", grace);
    }
    await vi.advanceTimersByTimeAsync(200);
    await speak(grace);
    socket.emit(sarvamSpeechEnd());
    socket.emit(sarvamSpeechStart());
    await endTurn(grace);

    socket.disconnect();
    await settle();
    const replacement = providerSockets().at(-1)!;
    replacement.emit(sarvamSpeechStart());
    replacement.emit(sarvamFinal("one", "Grace one."));
    replacement.emit(sarvamSpeechStart());
    replacement.emit(sarvamFinal("two", "Grace two."));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual(["First.", "Grace one.", "Grace two."]);
  });

  it("a line that owned its turn's new audio gives the next utterance's speech back when it ends, so a reconnect replays it as that utterance", async () => {
    vi.useFakeTimers();
    quiet();
    const { providerSockets, socket, savedTexts } = await secondUtteranceInTurn();
    socket.disconnect();
    await settle();
    const replacement = providerSockets().at(-1)!;
    expect(speechSent(replacement)).toBe(1);
    replacement.emit(sarvamSpeechStart());
    replacement.emit(sarvamFinal("two", "Grace two."));
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);
    expect(savedTexts()).toEqual(["First.", "Grace one.", "Grace two."]);
  });
});

describe("Greptile: ended-line cleanup keeps the line being shown", () => {
  it("a late final still fills a gap that ended in the same millisecond as a silent line, with a one-line cap", async () => {
    vi.useFakeTimers();
    quiet();
    const room = await transcriptRoomRig(lookup, OPENAI, { TRANSCRIPT_MAX_SEGMENTS: "1" });
    await room.start("en");
    const [socket] = room.providerSockets();
    await room.sendAudio("silence", grace);
    await room.commit(grace);
    await room.speak(ada);
    await room.commit(ada);
    socket.emit(openAiCommitted("silent"));
    socket.emit(openAiCommitted("heard"));
    await settle();
    await vi.advanceTimersByTimeAsync(DEADLINE + COMMIT_ACK_TIMEOUT + 1_000);
    expect(room.savedTexts()).toEqual([GAP]);

    socket.emit(openAiFinal("heard", "Late words."));
    await settle();

    expect(speakers(room.room.segments)).toEqual([["Late words.", "ada"]]);
    expect(speakers(room.viewerTranscript().segments)).toEqual([["Late words.", "ada"]]);
  });
});

describe("Greptile: Sarvam answers and owed slots", () => {
  it("keeps a second identical answer under a reused request id when it answers a later utterance", async () => {
    vi.useFakeTimers();
    quiet();
    const room = await rig(SARVAM);
    await room.start("hi");
    const [socket] = room.providerSockets();
    await room.speak(ada);
    socket.emit(sarvamSpeechStart());
    await room.endTurn(ada);
    socket.emit(sarvamFinal("shared", "Yes."));
    await settle();
    await room.speak(grace);
    socket.emit(sarvamSpeechStart());
    await room.endTurn(grace);
    socket.emit(sarvamFinal("shared", "Yes."));
    await settle();
    await room.speak(ada);
    socket.emit(sarvamSpeechStart());
    await room.endTurn(ada);
    socket.emit(sarvamFinal("shared", "Ada again."));
    await settle();
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);

    expect(speakers(room.room.segments)).toEqual([
      ["Yes.", "ada"],
      ["Yes.", "grace"],
      ["Ada again.", "ada"],
    ]);
  });

  it("still ignores an answer Sarvam sends twice for the same waiting line", async () => {
    vi.useFakeTimers();
    quiet();
    const room = await rig(SARVAM);
    await room.start("hi");
    const [socket] = room.providerSockets();
    await room.speak(ada);
    socket.emit(sarvamSpeechStart());
    await room.endTurn(ada);
    await room.speak(grace);
    socket.emit(sarvamSpeechStart());
    await room.endTurn(grace);
    socket.emit(sarvamFinal("shared", "Yes."));
    socket.emit(sarvamFinal("shared", "Yes."));
    socket.emit(sarvamFinal("shared", "Grace words."));
    await settle();
    await vi.advanceTimersByTimeAsync(DEADLINE + 100);

    expect(speakers(room.room.segments)).toEqual([
      ["Yes.", "ada"],
      ["Grace words.", "grace"],
    ]);
  });

  it("keeps owed slots bounded while Sarvam signals speech but sends no text", async () => {
    vi.useFakeTimers();
    quiet();
    const room = await rig(SARVAM);
    await room.start("hi");
    const [socket] = room.providerSockets();
    for (let utterance = 0; utterance < 40; utterance += 1) {
      const speaker = utterance % 2 === 0 ? ada : grace;
      await room.speak(speaker);
      socket.emit(sarvamSpeechStart());
      await room.endTurn(speaker);
      await vi.advanceTimersByTimeAsync(DEADLINE / 2);
    }
    const session = (room.room as unknown as {
      liveConnection: { session: { expiredSlots: Map<string, number>; awaitingFinal: string[] } };
    }).liveConnection.session;

    expect(session.expiredSlots.size).toBeLessThanOrEqual(8);
    expect(session.awaitingFinal.length).toBeLessThanOrEqual(10);
  });

  it("keeps every owed answer position for its whole window and refuses new heard lines once 16 are owed", async () => {
    vi.useFakeTimers();
    quiet();
    const room = await rig(SARVAM);
    await room.start("hi");
    const [socket] = room.providerSockets();
    for (let utterance = 0; utterance < 60; utterance += 1) {
      const speaker = utterance % 2 === 0 ? ada : grace;
      await room.speak(speaker);
      socket.emit(sarvamSpeechStart());
      await room.endTurn(speaker);
      await vi.advanceTimersByTimeAsync(700);
    }
    await vi.advanceTimersByTimeAsync(DEADLINE - 20_000);
    socket.emit(sarvamSpeechStart());
    const session = (room.room as unknown as {
      liveConnection: { session: { expiredSlots: Map<string, number>; awaitingFinal: string[] } };
    }).liveConnection.session;
    const now = Date.now();

    expect(session.expiredSlots.size).toBeGreaterThan(16);
    expect([...session.expiredSlots.values()].every((expiredAt) => now - expiredAt <= 60_000)).toBe(true);
    expect([...session.expiredSlots.keys()].every((itemId) => session.awaitingFinal.includes(itemId))).toBe(true);
    expect(room.savedTexts().filter((text) => text === GAP).length).toBeGreaterThan(16);
  });
});
