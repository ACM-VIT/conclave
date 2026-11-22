/**
 * Measures the authority runtime on a real SFU over real sockets.
 *
 *   pnpm -C packages/sfu exec tsx scripts/measure-authority-load.ts \
 *     [--clients 50] [--extra-tabs 10] [--guests 5] [--rate 100] \
 *     [--seconds 30] [--idle-seconds 10] [--kicks 3] [--port 5631] \
 *     [--out report.json]
 *
 * It starts an SFU process, joins `clients` signed-in identities (some with a
 * second tab) and a few guests through `joinRoom`, and offers `rate` actions
 * a second across Polls and Q&A. It reports:
 *
 * - the SFU's event-loop delay, utilization and CPU, read inside the SFU;
 * - bytes at each recipient socket, read from the TCP socket itself;
 * - unauthorized frames: every row a socket receives is checked against what
 *   that connection may see. The count must be 0.
 */
import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import { io as connectSocket, type Socket } from "socket.io-client";
import {
  AUTHORITY_EVENTS,
  AuthorityClient,
  type AuthorityFrame,
  type AuthoritySession,
  type Json,
} from "@conclave/apps-sdk/authority";
import { pollsContract } from "@conclave/apps-sdk/polls/core";
import { qaContract } from "@conclave/apps-sdk/qa/core";

const flag = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
};
const outIndex = process.argv.indexOf("--out");
const OUT = outIndex === -1 ? null : process.argv[outIndex + 1];

const CLIENTS = flag("clients", 50);
const EXTRA_TABS = flag("extra-tabs", 10);
const GUESTS = flag("guests", 5);
const RATE = flag("rate", 100);
const SECONDS = flag("seconds", 30);
const PORT = flag("port", 5631);
const KICKS = flag("kicks", 3);
const IDLE_SECONDS = flag("idle-seconds", 10);

const SECRET = randomBytes(32).toString("hex");
const CLIENT_ID = "conclave";
const ROOM_ID = `authority-load-${randomBytes(4).toString("hex")}`;
const SFU_URL = `http://127.0.0.1:${PORT}`;

type Person = { key: string; name: string; host: boolean; guest: boolean };

type Tab = {
  person: Person;
  seatId: string;
  socket: Socket;
  polls: AuthoritySession<typeof pollsContract>;
  qa: AuthoritySession<typeof qaContract>;
  frames: number;
  payloadBytes: number;
  kickedAt: number | null;
  tcp: { bytesRead: number } | null;
  tcpAtStart: number;
};

/**
 * What one person has done, across their tabs: the oracle for their rows.
 * `everUpvoted` only grows. A person's two tabs are two sockets with no
 * order between them, so one tab's "upvoted" frame can land after the other
 * tab took the upvote back. That row is still theirs. A row for a question
 * they never upvoted is not.
 */
type Ledger = {
  votes: Set<string>;
  upvotes: Set<string>;
  everUpvoted: Set<string>;
  asked: Set<string>;
};

const ledgers = new Map<string, Ledger>();
const ledgerOf = (person: Person): Ledger => {
  let ledger = ledgers.get(person.key);
  if (!ledger) {
    ledger = {
      votes: new Set(),
      upvotes: new Set(),
      everUpvoted: new Set(),
      asked: new Set(),
    };
    ledgers.set(person.key, ledger);
  }
  return ledger;
};

const violations: string[] = [];
const sharedPolls = new Set<string>();

const field = (value: Json, name: string): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? ((value as { readonly [key: string]: Json })[name] ?? null)
    : null;

/** Checks one received frame against what this connection may see. */
const audit = (tab: Tab, frame: AuthorityFrame): void => {
  if (frame.kind === "revoke" || frame.kind === "queryAbort") return;
  if (tab.kickedAt !== null) {
    violations.push(`${tab.person.name}: ${frame.kind} frame after removal`);
    return;
  }
  if (frame.kind === "query") return;
  const ledger = ledgerOf(tab.person);
  for (const row of frame.kind === "replace" ? frame.rows : frame.put) {
    if (row.bucket === "results") {
      // Totals exist only for hosts until a host shares them.
      if (!tab.person.host && !sharedPolls.has(row.key)) {
        violations.push(`${tab.person.name}: private tally for poll ${row.key}`);
      }
    } else if (row.bucket === "myVotes") {
      if (!ledger.votes.has(row.key)) {
        violations.push(`${tab.person.name}: someone else's ballot ${row.key}`);
      }
    } else if (row.bucket === "myUpvotes") {
      if (!ledger.everUpvoted.has(row.key)) {
        violations.push(`${tab.person.name}: someone else's upvote ${row.key}`);
      }
    } else if (row.bucket === "myQuestions") {
      if (!ledger.asked.has(row.key)) {
        violations.push(`${tab.person.name}: someone else's question ${row.key}`);
      }
    } else if (row.bucket === "questions") {
      if (field(row.value, "status") === "dismissed" && !tab.person.host) {
        violations.push(`${tab.person.name}: dismissed question ${row.key}`);
      }
    }
  }
};

const until = async (check: () => boolean, label: string, timeoutMs = 20_000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const startSfu = async (): Promise<ChildProcess> => {
  const data = mkdtempSync(join(tmpdir(), "authority-load-"));
  const child = fork(
    fileURLToPath(new URL("./authority-load-server.ts", import.meta.url)),
    [],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        SFU_PORT: String(PORT),
        SFU_SECRET: SECRET,
        SFU_CLIENT_ID: CLIENT_ID,
        SFU_CLIENT_POLICIES: JSON.stringify({
          [CLIENT_ID]: { useWaitingRoom: false },
        }),
        SFU_WORKER_COUNT: "1",
        ANNOUNCED_IP: "127.0.0.1",
        RTC_MIN_PORT: "56000",
        RTC_MAX_PORT: "56199",
        SFU_POSTHOG_ENABLED: "0",
        SFU_GAME_AI_ENABLED: "0",
        SFU_TRANSCRIPT_RELAY_ENABLED: "0",
        CONCLAVE_SQLITE_PATH: join(data, "conclave.sqlite"),
        RECORDING_STORAGE_PATH: data,
      },
    },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`SFU exited with ${code}`)));
    child.on("message", (message: { type?: string }) => {
      if (message.type === "ready") resolve();
    });
  });
  return child;
};

const request = <Reply>(child: ChildProcess, message: string, type: string) =>
  new Promise<Reply>((resolve) => {
    const listener = (reply: { type?: string }) => {
      if (reply.type !== type) return;
      child.off("message", listener);
      resolve(reply as Reply);
    };
    child.on("message", listener);
    child.send(message);
  });

const openTab = async (person: Person, session: string): Promise<Tab> => {
  const token = jwt.sign(
    {
      userId: person.key,
      email: person.guest ? undefined : person.key,
      name: person.name,
      sessionId: session,
      clientId: CLIENT_ID,
      isHost: person.host,
      isAdmin: person.host,
      allowRoomCreation: person.host,
      joinMode: "meeting",
    },
    SECRET,
    { algorithm: "HS256" },
  );
  const socket = connectSocket(SFU_URL, {
    auth: { token },
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
  const joined = await new Promise<{ error?: string; status?: string }>((resolve) =>
    socket.emit("joinRoom", { roomId: ROOM_ID, sessionId: session }, resolve),
  );
  if (joined.error || joined.status === "waiting") {
    throw new Error(`${person.name} could not join: ${joined.error ?? joined.status}`);
  }
  const client = new AuthorityClient({ socket, ackTimeoutMs: 5_000 });
  const tab: Tab = {
    person,
    seatId: `${person.key}#${session}`,
    socket,
    polls: client.open(pollsContract),
    qa: client.open(qaContract),
    frames: 0,
    payloadBytes: 0,
    kickedAt: null,
    tcp: null,
    tcpAtStart: 0,
  };
  socket.on(AUTHORITY_EVENTS.frame, (frame: AuthorityFrame) => {
    tab.frames += 1;
    tab.payloadBytes += Buffer.byteLength(JSON.stringify(frame));
    audit(tab, frame);
  });
  // The server tells a socket it was removed before closing it, and a socket
  // delivers in order, so any frame after this point was sent after removal.
  const removed = (): void => {
    if (tab.kickedAt === null) tab.kickedAt = Date.now();
  };
  socket.on("kicked", removed);
  socket.on("disconnect", removed);
  client.joined();
  await until(
    () => tab.polls.getState().kind === "ready" && tab.qa.getState().kind === "ready",
    `${person.name} ready`,
  );
  const transport = socket.io.engine.transport as unknown as {
    ws?: { _socket?: { bytesRead: number } };
  };
  tab.tcp = transport.ws?._socket ?? null;
  return tab;
};

const main = async (): Promise<void> => {
  console.log(`starting an SFU on :${PORT}`);
  const sfu = await startSfu();
  const tabs: Tab[] = [];
  try {
    const people: Person[] = [
      { key: "host@load.test", name: "Host", host: true, guest: false },
      ...Array.from({ length: CLIENTS - 1 }, (_, index) => ({
        key: `person${index + 1}@load.test`,
        name: `Person ${index + 1}`,
        host: false,
        guest: false,
      })),
    ];
    const guests: Person[] = Array.from({ length: GUESTS }, (_, index) => ({
      key: `guest-load${index + 1}`,
      name: `Guest ${index + 1}`,
      host: false,
      guest: true,
    }));

    tabs.push(await openTab(people[0], "s1"));
    for (const person of people.slice(1)) tabs.push(await openTab(person, "s1"));
    for (const person of people.slice(1, 1 + EXTRA_TABS)) {
      tabs.push(await openTab(person, "s2"));
    }
    for (const guest of guests) tabs.push(await openTab(guest, "s1"));
    console.log(`${tabs.length} sockets joined for ${people.length + guests.length} people`);

    const host = tabs[0];
    const members = tabs.filter((tab) => !tab.person.host && !tab.person.guest);
    const guestTabs = tabs.filter((tab) => tab.person.guest);

    // Seed: a few polls and a board of questions, before measuring.
    const pollIds: string[] = [];
    const questionIds: string[] = [];
    const createPoll = async (): Promise<void> => {
      const created = await host.polls.act("create", {
        question: `Poll ${pollIds.length + 1}?`,
        options: ["Tea", "Coffee", "Water"],
      });
      if (created.ok) pollIds.push(created.value.pollId);
    };
    await createPoll();
    for (const tab of members.slice(0, 40)) {
      const ledger = ledgerOf(tab.person);
      const asked = await tab.qa.act("ask", {
        text: `What does ${tab.person.name} want to know about this?`,
      });
      if (asked.ok) {
        ledger.asked.add(asked.value.id);
        questionIds.push(asked.value.id);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));

    // The same instrument on the same idle room first, so the load figures
    // can be read against what an idle SFU with these sockets reports.
    await request(sfu, "reset", "reset");
    await new Promise((resolve) => setTimeout(resolve, IDLE_SECONDS * 1000));
    const idle = await request<Record<string, unknown>>(sfu, "report", "report");

    for (const tab of tabs) tab.tcpAtStart = tab.tcp?.bytesRead ?? 0;
    for (const tab of tabs) {
      tab.frames = 0;
      tab.payloadBytes = 0;
    }
    await request(sfu, "reset", "reset");

    const outcomes = new Map<string, number>();
    const count = (name: string): void => {
      outcomes.set(name, (outcomes.get(name) ?? 0) + 1);
    };
    const record = (kind: string, result: { ok: boolean; code?: string; reason?: string }) =>
      count(result.ok ? `${kind}:ok` : `${kind}:${result.reason ?? result.code}`);
    const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

    let offered = 0;
    const kicking = new Set<Tab>();
    const pending: Promise<unknown>[] = [];
    const kickTimes = Array.from(
      { length: KICKS },
      (_, index) => ((index + 1) * SECONDS * 1000) / (KICKS + 1),
    );
    const startedAt = Date.now();
    const stepMs = 1000 / RATE;

    await new Promise<void>((resolve) => {
      const tick = (): void => {
        const elapsed = Date.now() - startedAt;
        if (elapsed >= SECONDS * 1000) {
          resolve();
          return;
        }
        while (offered < Math.floor(elapsed / stepMs)) {
          offered += 1;
          const roll = Math.random();
          const live = members.filter(
            (tab) => tab.kickedAt === null && !kicking.has(tab),
          );
          if (roll < 0.7 && questionIds.length > 0) {
            const tab = pick(live);
            const ledger = ledgerOf(tab.person);
            const id = pick(questionIds);
            const value = !ledger.upvotes.has(id);
            // Recorded before sending: the row may arrive before the ack.
            if (value) {
              ledger.upvotes.add(id);
              ledger.everUpvoted.add(id);
            }
            pending.push(
              tab.qa.act("upvote", { id, value }).then((result) => {
                record("upvote", result);
                if (result.ok && !value) ledger.upvotes.delete(id);
              }),
            );
          } else if (roll < 0.9 && pollIds.length > 0) {
            const tab = pick(live);
            const ledger = ledgerOf(tab.person);
            const pollId = pick(pollIds);
            const first = !ledger.votes.has(pollId);
            ledger.votes.add(pollId);
            pending.push(
              tab.polls
                .act("vote", { pollId, optionIds: [pick(["o1", "o2", "o3"])] })
                .then((result) => record(first ? "vote" : "vote-again", result)),
            );
          } else if (roll < 0.93) {
            const tab = pick(live);
            const ledger = ledgerOf(tab.person);
            pending.push(
              tab.qa.act("ask", { text: `A later question from ${tab.person.name}` }).then((result) => {
                record("ask", result);
                if (result.ok) {
                  ledger.asked.add(result.value.id);
                  questionIds.push(result.value.id);
                }
              }),
            );
          } else if (roll < 0.96 && questionIds.length > 0) {
            const id = pick(questionIds);
            pending.push(
              host.qa
                .act("moderate", { id, action: pick(["answering", "answered", "dismissed", "reopen"]) })
                .then((result) => record("moderate", result)),
            );
          } else if (roll < 0.98) {
            pending.push(createPoll().then(() => count("create:ok")));
          } else if (guestTabs.length > 0 && pollIds.length > 0) {
            pending.push(
              pick(guestTabs)
                .polls.act("vote", { pollId: pick(pollIds), optionIds: ["o1"] })
                .then((result) => record("guest-vote", result)),
            );
          }
        }
        // Remove a few people mid-run: nothing may reach them afterwards.
        while (kickTimes.length > 0 && elapsed >= kickTimes[0]) {
          kickTimes.shift();
          const target = pick(
            members.filter((tab) => tab.kickedAt === null && !kicking.has(tab)),
          );
          kicking.add(target);
          host.socket.emit("kickUser", { userId: target.seatId }, () =>
            count("kick"),
          );
        }
        setTimeout(tick, 5);
      };
      tick();
    });

    await Promise.race([
      Promise.allSettled(pending),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const seconds = (Date.now() - startedAt) / 1000;
    const server = await request<Record<string, unknown>>(sfu, "report", "report");

    const live = tabs.filter((tab) => tab.kickedAt === null);
    const wire = live.map((tab) => (tab.tcp?.bytesRead ?? 0) - tab.tcpAtStart);
    const payload = live.map((tab) => tab.payloadBytes);
    const sum = (list: number[]): number => list.reduce((a, b) => a + b, 0);
    const report = {
      sockets: tabs.length,
      people: people.length + guests.length,
      seconds: Math.round(seconds * 10) / 10,
      actionsOfferedPerSecond: Math.round((offered / seconds) * 10) / 10,
      outcomes: Object.fromEntries([...outcomes].sort()),
      sfuIdle: idle,
      sfuUnderLoad: server,
      recipient: {
        framesPerSocketPerSecond: Math.round((sum(live.map((tab) => tab.frames)) / live.length / seconds) * 10) / 10,
        wireBytesPerSocketPerSecond: Math.round(sum(wire) / live.length / seconds),
        wireBytesMaxSocketPerSecond: Math.round(Math.max(...wire) / seconds),
        framePayloadBytesPerSocketPerSecond: Math.round(sum(payload) / live.length / seconds),
        roomWireBytesPerSecond: Math.round(sum(wire) / seconds),
      },
      removedMidRun: tabs.filter((tab) => tab.kickedAt !== null).length,
      unauthorizedFrames: violations.length,
      unauthorizedSamples: violations.slice(0, 10),
    };
    console.log(JSON.stringify(report, null, 2));
    if (OUT) writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = violations.length === 0 ? 0 : 1;
  } finally {
    for (const tab of tabs) tab.socket.disconnect();
    sfu.send("stop");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    sfu.kill();
  }
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
