import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPTION_GAP_MARKER as GAP,
  TRANSCRIPTION_LINE_DEADLINE_MS as DEADLINE,
} from "../transcript-worker/src/constants";
import {
  OPENAI,
  SARVAM,
  openAiCommitted,
  openAiDelta,
  openAiFinal,
  sarvamFinal,
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
    const { providerSockets, start, speak, commit, savedTexts, broadcastPlaces } = await rig(OPENAI);
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
    expect([...broadcastPlaces().get("a")!]).toHaveLength(1);
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

  it("Sarvam: the first speech signal takes the place its audio opened and frees the places of earlier noise", async () => {
    vi.useFakeTimers();
    const { providerSockets, start, speak, endTurn, savedTexts, restartedTexts } = await rig(SARVAM);
    await start("hi");
    const [socket] = providerSockets();
    for (const _ of [1, 2]) {
      await speak();
      await endTurn();
    }
    expect(await restartedTexts()).toEqual([GAP, GAP]);

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

type Provider = "openai" | "sarvam";
type Connection = {
  socket: FakeProviderSocket;
  provider: Provider;
  unacknowledged: Utterance[];
  awaiting: Utterance[];
  stalled: boolean;
};
type Utterance = {
  text: string;
  itemId: string;
  connection: Connection;
  placedAt: number | null;
  partial: string | null;
  final: "pending" | "shown" | "ignored";
};

const LANGUAGES: Record<Provider, string[]> = { openai: ["en", "fr", "de", "hi"], sarvam: ["hi", "ta", "bn"] };

describe("invariant: every utterance a provider accepted ends as its text or a gap in its place", () => {
  it.each(Array.from({ length: 400 }, (_, index) => index + 1))("seed %i", async (seed) => {
    vi.useFakeTimers();
    quiet();
    const random = seeded(seed);
    const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];
    const sarvamSignalsSpeech = random() < 0.5;
    let provider: Provider = random() < 0.5 ? "openai" : "sarvam";
    const model = (of: Provider) => (of === "openai" ? OPENAI : SARVAM);
    const { providerSockets, start, switchTo, useModel, speak, commit, endTurn, savedTexts, restartedTexts } =
      await rig(model(provider));
    await start(pick(LANGUAGES[provider]));

    const connections: Connection[] = [];
    const connect = () => {
      const connection: Connection = {
        socket: providerSockets().at(-1)!,
        provider,
        unacknowledged: [],
        awaiting: [],
        stalled: false,
      };
      connections.push(connection);
      return connection;
    };
    let live = connect();
    const utterances: Utterance[] = [];
    const deadlineOf = (utterance: Utterance) => utterance.placedAt! + DEADLINE;
    const acknowledge = (connection: Connection) => {
      const utterance = connection.unacknowledged.shift()!;
      connection.socket.emit(openAiCommitted(utterance.itemId));
      utterance.placedAt ??= Date.now();
      connection.awaiting.push(utterance);
    };
    const acknowledgeLive = () => {
      while (live.provider === "openai" && live.unacknowledged.length) acknowledge(live);
    };
    const expectedText = (utterance: Utterance) =>
      utterance.final === "shown" ? utterance.text : utterance.partial || GAP;

    const moves: Record<string, () => Promise<void>> = {
      async utter() {
        const utterance: Utterance = {
          text: `Line ${utterances.length}.`,
          itemId: `c${connections.indexOf(live)}_u${utterances.length}`,
          connection: live,
          placedAt: null,
          partial: null,
          final: "pending",
        };
        utterances.push(utterance);
        await speak();
        if (live.provider === "openai") {
          await commit();
          live.unacknowledged.push(utterance);
          if (random() < 0.7) acknowledge(live);
        } else {
          if (sarvamSignalsSpeech) live.socket.emit(sarvamSpeechStart());
          utterance.placedAt = Date.now();
          live.awaiting.push(utterance);
          await endTurn();
        }
      },
      async acknowledge() {
        const waiting = connections.filter(({ unacknowledged }) => unacknowledged.length);
        if (waiting.length) acknowledge(pick(waiting));
      },
      async final() {
        const answering = connections.filter(({ awaiting, stalled }) => awaiting.length && !stalled);
        if (!answering.length) return;
        const connection = pick(answering);
        const utterance = connection.provider === "openai" ? pick(connection.awaiting) : connection.awaiting[0];
        connection.awaiting.splice(connection.awaiting.indexOf(utterance), 1);
        if (Date.now() < deadlineOf(utterance)) {
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
          .filter(({ provider: of }) => of === "openai")
          .flatMap(({ awaiting }) => awaiting.filter(({ partial }) => partial === null));
        if (!showing.length) return;
        const utterance = pick(showing);
        const words = `${utterance.text} so far`;
        utterance.connection.socket.emit(openAiDelta(utterance.itemId, words));
        const shown = !utterance.connection.socket.closed && Date.now() < deadlineOf(utterance);
        utterance.partial = shown ? words : "";
      },
      async lose() {
        const answering = connections.filter(({ awaiting, stalled }) => awaiting.length && !stalled);
        if (!answering.length) return;
        const connection = pick(answering);
        if (connection.provider === "sarvam") {
          connection.stalled = true;
        } else {
          connection.awaiting.splice(Math.floor(random() * connection.awaiting.length), 1);
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
        for (const utterance of previous.unacknowledged) utterance.placedAt = Date.now();
        live = connect();
      },
      async restart() {
        const placed = utterances.filter(({ placedAt }) => placedAt !== null);
        const texts = await restartedTexts();
        expect(texts, "a restart keeps one place per accepted utterance").toHaveLength(placed.length);
        placed.forEach((utterance, index) => {
          const allowed = utterance.final === "shown" ? [utterance.text] : [GAP, ...(utterance.partial ? [utterance.partial] : [])];
          expect(allowed, `${utterance.text} after a restart`).toContain(texts[index]);
        });
      },
    };
    const weights: [string, number][] = [
      ["utter", 30],
      ["final", 24],
      ["delta", 8],
      ["wait", 14],
      ["switch", 9],
      ["lose", 4],
      ["acknowledge", 4],
      ["restart", 7],
    ];
    const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
    for (let step = 0; step < 28; step += 1) {
      let roll = random() * total;
      const [move] = weights.find(([, weight]) => (roll -= weight) < 0) ?? weights[0];
      await moves[move]();
      await settle();
    }

    acknowledgeLive();
    await settle();
    await moves.restart();
    await vi.advanceTimersByTimeAsync(2 * DEADLINE + 15_000);
    expect(savedTexts()).toEqual(utterances.map(expectedText));
    expect(await restartedTexts()).toEqual(utterances.map(expectedText));
    expect(connections.slice(0, -1).every(({ socket }) => socket.closed), "every replaced socket closes").toBe(true);
  });
});
