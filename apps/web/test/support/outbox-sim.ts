import * as currentOutbox from "../../src/app/lib/telemetry-outbox";

type Reply = { status: number; retryAfter: string | null };

type OutboxLike = {
  add: (event: { uuid: string; event: string; timestamp?: string; properties: Record<string, unknown> }, options?: { urgent?: boolean; deferred?: boolean }) => void;
  flushForUnload: () => void;
  replaySaved: () => void;
};

export type OutboxModule = {
  createOutbox: (deps: never) => OutboxLike;
  createBatchStore: (storage: () => Storage) => unknown;
};

export type Violation = { at: number; kind: string; detail: string };

export type SimResult = {
  seed: number;
  violations: Violation[];
  tabs: number;
  events: number;
  delivered: number;
  refused: number;
  counted: number;
  lostAtClose: number;
  posts: number;
  beacons: number;
  steps: number;
  aborted: number;
  refusedWrites: number;
  retryAfters: number;
  closes: number;
};

const START = Date.parse("2026-11-23T00:00:00.000Z");
const PROJECT = "phc_sim_project";
const SCHEDULE = [2000, 4000, 8000, 16000, 30000];
const MAX_WAIT_MS = 60_000;
const BEACON_CONFIRM_MS = 30_000;

const rngOf = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

type Job = { at: number; seq: number; tab: Tab | null; kind: "timer" | "reply" | "server" | "storage" | "action"; run: () => void; cancelled: boolean };

type Tab = { id: number; open: boolean; hidden: boolean; outbox: OutboxLike };

type Request = { key: string; uuids: string[]; tab: Tab; keepalive: boolean; latest: boolean; done: boolean; arrived: boolean; aborted: boolean };

export type Profile = {
  maxTabs: number;
  refuseRate: number;
  slowRate: number;
  mediumRate: number;
  okRate: number;
  limitRate: number;
  waitRate: number;
  errorRate: number;
  refuseBodyRate: number;
  beaconRefuseRate: number;
  beaconLossRate: number;
  beaconLimitRate: number;
  activeMs: number;
};

const profileOf = (rng: () => number): Omit<Profile, "beaconLimitRate"> => ({
  maxTabs: 1 + Math.floor(rng() * 3),
  refuseRate: rng() < 0.4 ? 0 : rng() * 0.5,
  slowRate: rng() * 0.3,
  mediumRate: rng() * 0.3,
  okRate: 0.35 + rng() * 0.6,
  limitRate: rng() * 0.6,
  waitRate: rng() * 0.3,
  errorRate: rng() * 0.3,
  refuseBodyRate: rng() < 0.8 ? 0 : 0.02,
  beaconRefuseRate: rng() * 0.3,
  beaconLossRate: rng() * 0.3,
  activeMs: 120_000 + Math.floor(rng() * 240_000),
});

export type ScriptedReply = { latency: number; status: number | null; retryAfter?: string };

export type ScriptedAction = { at: number; act: "open" | "emit" | "hide" | "show" | "close"; tab: number; count?: number };

export type Scenario = { profile?: Partial<Profile>; replies?: ScriptedReply[]; actions?: ScriptedAction[] };

export async function simulate(
  seed: number,
  outboxModule: OutboxModule = currentOutbox as unknown as OutboxModule,
  trace?: (line: string) => void,
  scenario: Scenario = {},
): Promise<SimResult> {
  const rng = rngOf(seed);
  const beaconRng = rngOf(seed ^ 0x5bd1e995);
  const between = (low: number, high: number) => low + rng() * (high - low);
  const scriptedEnd = scenario.actions ? Math.max(...scenario.actions.map((action) => action.at)) + 1 : null;
  const profile: Profile = {
    ...profileOf(rng),
    beaconLimitRate: beaconRng() * 0.3,
    ...(scriptedEnd === null ? {} : { activeMs: scriptedEnd }),
    ...scenario.profile,
  };
  const scriptedReplies = [...(scenario.replies ?? [])];
  const violations: Violation[] = [];
  let clock = START;
  const note = (line: string) => trace?.(`${((clock - START) / 1000).toFixed(3)} ${line}`);
  const violate = (kind: string, detail: string) => {
    note(`VIOLATION ${kind}: ${detail}`);
    if (violations.length < 20) violations.push({ at: clock - START, kind, detail });
  };

  const jobs: Job[] = [];
  let seq = 0;
  const schedule = (at: number, tab: Tab | null, kind: Job["kind"], run: () => void): Job => {
    const job: Job = { at: Math.max(at, clock), seq: ++seq, tab, kind, run, cancelled: false };
    jobs.push(job);
    return job;
  };
  const nextJob = (): Job | null => {
    let best = -1;
    for (let index = 0; index < jobs.length; index++) {
      const job = jobs[index];
      if (best < 0 || job.at < jobs[best].at || (job.at === jobs[best].at && job.seq < jobs[best].seq)) best = index;
    }
    return best < 0 ? null : jobs.splice(best, 1)[0];
  };

  const allEvents = new Set<string>();
  const delivered = new Set<string>();
  const refused = new Set<string>();
  const counted = new Set<string>();
  const countedTwice: string[] = [];
  let countedTotal = 0;
  let exactCounts = true;
  const lostAtClose = new Set<string>();
  const waitUntil = new Map<string, number>();
  const beaconedAt = new Map<string, number>();
  let refusingUntil = 0;
  const failures = new Map<string, { count: number; at: number }>();
  const requests = new Map<string, Request[]>();
  let posts = 0;
  let beacons = 0;
  let aborted = 0;
  let refusedWrites = 0;
  let retryAfters = 0;
  let closes = 0;
  let ids = 0;
  const tabs: Tab[] = [];

  const items = new Map<string, string>();
  const writtenAt = new Map<string, number>();
  let closingTab: Tab | null = null;
  const notifyOthers = (writer: Tab) => {
    for (const tab of tabs) {
      if (tab !== writer && tab.open) schedule(clock + between(0, 30), tab, "storage", () => tab.outbox.replaySaved());
    }
  };
  const storageFor = (tab: Tab): Storage => ({
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (clock < refusingUntil || rng() < profile.refuseRate) {
        refusedWrites += 1;
        if (closingTab === tab) {
          try {
            for (const event of (JSON.parse(value) as { events: Array<{ uuid: string }> }).events) lostAtClose.add(event.uuid);
          } catch {}
        }
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      }
      items.set(key, value);
      writtenAt.set(key, clock);
      if (trace) note(`tab${tab.id} saved ${key.slice(-12)} ${value.replace(/"events":\[.*?\],/, "")}`);
      notifyOthers(tab);
    },
    removeItem: (key: string) => {
      if (items.delete(key)) {
        note(`tab${tab.id} removed ${key.slice(-12)}`);
        notifyOthers(tab);
      }
    },
    clear: () => items.clear(),
  });

  const waiting: Array<{ tab: Tab; run: () => Promise<void> }> = [];
  let held = false;
  const pump = () => {
    while (!held && waiting.length > 0) {
      const next = waiting.shift() as { tab: Tab; run: () => Promise<void> };
      if (!next.tab.open) continue;
      held = true;
      void Promise.resolve()
        .then(next.run)
        .catch(() => {})
        .finally(() => {
          held = false;
          pump();
        });
    }
  };

  const keyOf = (uuids: string[]) => [...uuids].sort().join(",");
  const checkSend = (key: string, how: "post" | "beacon") => {
    const until = waitUntil.get(key) ?? 0;
    if (clock < until) violate("sent before its Retry-After", `${how} of ${key} ${until - clock} ms early`);
    const beaconed = beaconedAt.get(key);
    if (beaconed !== undefined && clock - beaconed < BEACON_CONFIRM_MS) {
      violate("sent again before its beacon is confirmed", `${how} of ${key} ${clock - beaconed} ms after its beacon`);
    }
    if (how === "post") {
      const open = (requests.get(key) ?? []).filter((request) => !request.done && request.tab.open);
      if (open.length > 0) violate("two sends of one batch in flight", key);
    }
    const failed = failures.get(key);
    if (failed && failed.count > 0) {
      const gap = SCHEDULE[Math.min(failed.count - 1, SCHEDULE.length - 1)];
      if (clock - failed.at < gap) violate("sent sooner than its backoff", `${key} after ${clock - failed.at} ms, needs ${gap}`);
    }
  };
  const failed = (request: Request) => {
    if (!request.latest) return;
    const previous = failures.get(request.key);
    failures.set(request.key, { count: (previous?.count ?? 0) + 1, at: clock });
  };

  const network = (tab: Tab) => (body: string, keepalive: boolean, signal?: AbortSignal): Promise<Reply> => {
    const uuids = (JSON.parse(body) as { batch: Array<{ uuid: string }> }).batch.map((event) => event.uuid);
    const key = keyOf(uuids);
    checkSend(key, "post");
    note(`tab${tab.id} post ${key.slice(0, 40)} keepalive=${keepalive}`);
    posts += 1;
    const earlier = requests.get(key) ?? [];
    for (const request of earlier) request.latest = false;
    const request: Request = { key, uuids, tab, keepalive, latest: true, done: false, arrived: false, aborted: false };
    requests.set(key, [...earlier.filter((each) => !each.done), request]);
    const roll = rng();
    const scripted = scriptedReplies.shift();
    const latency = scripted
      ? scripted.latency
      : roll < profile.slowRate
        ? between(10_000, 40_000)
        : roll < profile.slowRate + profile.mediumRate
          ? between(1000, 9000)
          : between(20, 800);
    const kindRoll = rng();
    const outcome: { status: number | null; retryAfter: string | null } = scripted
      ? { status: scripted.status, retryAfter: scripted.retryAfter ?? null }
      : kindRoll < profile.okRate
        ? { status: 200, retryAfter: null }
        : kindRoll < profile.okRate + profile.refuseBodyRate
          ? { status: 400, retryAfter: null }
          : rng() < profile.limitRate
            ? { status: rng() < 0.7 ? 429 : 503, retryAfter: String(1 + Math.floor(rng() * 120)) }
            : rng() < profile.errorRate
              ? { status: null, retryAfter: null }
              : { status: rng() < 0.5 ? 503 : 500, retryAfter: rng() < profile.waitRate ? String(1 + Math.floor(rng() * 90)) : null };
    const sentAt = clock;
    return new Promise<Reply>((resolve, reject) => {
      const finish = (act: () => void) => {
        if (request.done) return;
        request.done = true;
        act();
      };
      signal?.addEventListener(
        "abort",
        () => {
          if (request.done) return;
          request.aborted = true;
          aborted += 1;
          failed(request);
          finish(() => reject(new DOMException("The operation was aborted.", "AbortError")));
        },
        { once: true },
      );
      schedule(sentAt + latency * between(0.2, 0.8), null, "server", () => {
        if (request.aborted || (!tab.open && !request.keepalive)) return;
        request.arrived = true;
        if (uuids.every((uuid) => delivered.has(uuid))) {
          outcome.status = 200;
          outcome.retryAfter = null;
        }
        if (outcome.status === 200) for (const uuid of uuids) delivered.add(uuid);
        if (outcome.status === 400) for (const uuid of uuids) if (!delivered.has(uuid)) refused.add(uuid);
      });
      schedule(sentAt + latency, tab, "reply", () => {
        if (!tab.open) {
          request.done = true;
          return;
        }
        if (request.done) return;
        if (!request.arrived && outcome.status !== null) outcome.status = null;
        if (outcome.status === null) {
          failed(request);
          finish(() => reject(new TypeError("Failed to fetch")));
          return;
        }
        const status = outcome.status;
        if (status === 429 || status >= 500) {
          if (outcome.retryAfter !== null) retryAfters += 1;
          if (request.latest && outcome.retryAfter !== null) {
            const until = clock + Math.min(Number(outcome.retryAfter) * 1000, MAX_WAIT_MS);
            waitUntil.set(key, Math.max(waitUntil.get(key) ?? 0, until));
          }
          failed(request);
        }
        note(`tab${tab.id} reply ${status} ra=${outcome.retryAfter} for ${key.slice(0, 40)} latest=${request.latest}`);
        finish(() => resolve({ status, retryAfter: outcome.retryAfter }));
      });
    });
  };

  const beaconFor = (tab: Tab) => (body: string): Promise<Reply | null> | null => {
    const uuids = (JSON.parse(body) as { batch: Array<{ uuid: string }> }).batch.map((event) => event.uuid);
    const key = keyOf(uuids);
    checkSend(key, "beacon");
    if (rng() < profile.beaconRefuseRate) return null;
    beaconedAt.set(key, clock);
    beacons += 1;
    if (beaconRng() < profile.beaconLimitRate) {
      const status = beaconRng() < 0.7 ? 429 : 503;
      const retryAfter = String(1 + Math.floor(beaconRng() * 120));
      const answeredAt = clock + 20 + beaconRng() * 780;
      return new Promise<Reply | null>((resolve) => {
        schedule(answeredAt, tab, "reply", () => {
          if (!tab.open) return;
          retryAfters += 1;
          waitUntil.set(key, Math.max(waitUntil.get(key) ?? 0, clock + Math.min(Number(retryAfter) * 1000, MAX_WAIT_MS)));
          note(`tab${tab.id} beacon answered ${status} ra=${retryAfter} for ${key.slice(0, 40)}`);
          resolve({ status, retryAfter });
        });
      });
    }
    if (rng() >= profile.beaconLossRate) for (const uuid of uuids) delivered.add(uuid);
    return Promise.resolve(null);
  };

  const onStale = (dropped: unknown) => {
    if (Array.isArray(dropped)) {
      for (const batch of dropped as Array<{ events: Array<{ uuid: string }> }>) {
        for (const event of batch.events) {
          if (counted.has(event.uuid)) countedTwice.push(event.uuid);
          counted.add(event.uuid);
        }
      }
    } else {
      exactCounts = false;
      countedTotal += (dropped as { events: number }).events;
    }
  };

  const openTab = () => {
    const tab: Tab = { id: tabs.length + 1, open: true, hidden: false, outbox: undefined as unknown as OutboxLike };
    const deps = {
      token: PROJECT,
      now: () => clock,
      setTimer: (run: () => void, ms: number) => schedule(clock + ms, tab, "timer", run),
      clearTimer: (job: unknown) => {
        if (job) (job as Job).cancelled = true;
      },
      post: network(tab),
      beacon: beaconFor(tab),
      newId: () => `sim-${seed}-${++ids}`,
      store: outboxModule.createBatchStore(() => storageFor(tab)),
      lock: (run: () => Promise<void>) => {
        waiting.push({ tab, run });
        pump();
      },
      onStale,
    };
    tab.outbox = outboxModule.createOutbox(deps as never);
    tabs.push(tab);
    note(`tab${tab.id} opens`);
    tab.outbox.replaySaved();
    return tab;
  };

  let eventIds = 0;
  const active = () => clock - START < profile.activeMs;
  const emit = (tab: Tab, scriptedCount?: number) => {
    if (!tab.open || !active()) return;
    const count = scriptedCount ?? 1 + Math.floor(rng() * 4);
    for (let index = 0; index < count; index++) {
      const urgent = rng() < 0.1;
      const uuid = `0196f0a1-0000-7000-8000-${((seed % 1_000_000_000) * 100_000 + ++eventIds).toString(16).padStart(12, "0")}`;
      allEvents.add(uuid);
      const event = {
        uuid,
        event: urgent ? "$exception" : "meet_join_attempt",
        timestamp: new Date(clock).toISOString(),
        properties: { token: PROJECT, joinMode: "meeting" },
      };
      if (tab.hidden) {
        tab.outbox.add(event, { deferred: true });
        tab.outbox.flushForUnload();
      } else {
        tab.outbox.add(event, { urgent });
      }
    }
    if (scriptedCount === undefined) schedule(clock + between(500, 12_000), tab, "action", () => emit(tab));
  };
  const closeTab = (tab: Tab) => {
    note(`tab${tab.id} closes`);
    closes += 1;
    closingTab = tab;
    tab.outbox.flushForUnload();
    closingTab = null;
    tab.open = false;
    for (const job of jobs) if (job.tab === tab && job.kind !== "reply") job.cancelled = true;
  };
  const act = () => {
    if (!active()) return;
    const open = tabs.filter((tab) => tab.open);
    const roll = rng();
    if (open.length < profile.maxTabs && (open.length === 0 || roll < 0.25)) {
      emit(openTab());
    } else if (roll < 0.6 && open.length > 0) {
      const tab = open[Math.floor(rng() * open.length)];
      if (roll >= 0.45) {
        refusingUntil = clock + between(5000, 60_000);
        note(`storage refuses every write until ${((refusingUntil - START) / 1000).toFixed(3)}`);
      }
      if (!tab.hidden) {
        note(`tab${tab.id} hides`);
        tab.hidden = true;
        tab.outbox.flushForUnload();
        schedule(clock + between(1000, 120_000), tab, "action", () => {
          if (!tab.open) return;
          tab.hidden = false;
          tab.outbox.replaySaved();
        });
      }
    } else if (roll < 0.7 && open.length > 0) {
      const tab = open[Math.floor(rng() * open.length)];
      if (rng() < 0.5) refusingUntil = clock + between(5000, 60_000);
      note(`tab${tab.id} goes through a burst of lifecycle events`);
      tab.hidden = true;
      tab.outbox.flushForUnload();
      const bursts = 1 + Math.floor(rng() * 2);
      for (let index = 1; index <= bursts; index++) {
        schedule(clock + index * between(50, 250), tab, "action", () => tab.outbox.flushForUnload());
      }
      schedule(clock + between(1000, 90_000), tab, "action", () => {
        if (!tab.open) return;
        tab.hidden = false;
        tab.outbox.replaySaved();
      });
    } else if (roll < 0.85 && open.length > 0) {
      closeTab(open[Math.floor(rng() * open.length)]);
    }
    schedule(clock + between(5000, 60_000), null, "action", act);
  };

  const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
  const settled = (uuid: string) => delivered.has(uuid) || refused.has(uuid) || lostAtClose.has(uuid);
  const unsettled = () => [...allEvents].filter((uuid) => !settled(uuid) && !counted.has(uuid));
  const GRACE_MS = 1000;
  const savedWithoutOwner = (): string | null => {
    for (const [key, text] of items) {
      if (!key.startsWith("conclave:telemetry:batch:")) continue;
      let saved: { events: Array<{ uuid: string }>; notBefore?: number; nextTry?: number; leaseUntil?: number };
      try {
        saved = JSON.parse(text);
      } catch {
        continue;
      }
      const due = Math.max(saved.notBefore ?? 0, saved.nextTry ?? 0, saved.leaseUntil ?? 0, writtenAt.get(key) ?? 0);
      if (clock - due <= GRACE_MS) continue;
      const batchKey = keyOf(saved.events.map((event) => event.uuid));
      if ((requests.get(batchKey) ?? []).some((request) => !request.done && request.tab.open)) continue;
      return `${key.slice("conclave:telemetry:batch:".length)} due ${clock - due} ms ago`;
    }
    return null;
  };

  if (scenario.actions) {
    for (const action of scenario.actions) {
      schedule(START + action.at, null, "action", () => {
        const tab = tabs[action.tab - 1];
        if (action.act === "open") openTab();
        else if (!tab?.open) return;
        else if (action.act === "emit") emit(tab, action.count ?? 1);
        else if (action.act === "hide") {
          note(`tab${tab.id} hides`);
          tab.hidden = true;
          tab.outbox.flushForUnload();
        } else if (action.act === "show") {
          note(`tab${tab.id} shows`);
          tab.hidden = false;
          tab.outbox.replaySaved();
        } else closeTab(tab);
      });
    }
  } else {
    emit(openTab());
    schedule(clock + between(2000, 30_000), null, "action", act);
  }
  let steps = 0;
  let finalPhase = false;
  const horizon = START + profile.activeMs + 15 * 60_000;
  for (;;) {
    const job = nextJob();
    if (!job) {
      if (!finalPhase) {
        finalPhase = true;
        if (!tabs.some((tab) => tab.open)) openTab();
        await drain();
        continue;
      }
      break;
    }
    if (job.at > horizon) break;
    if (job.cancelled) continue;
    clock = job.at;
    if (job.tab && !job.tab.open && job.kind !== "reply") continue;
    job.run();
    await drain();
    steps += 1;
    if (!active() && !finalPhase && !jobs.some((each) => !each.cancelled && each.kind !== "action")) {
      finalPhase = true;
      if (!tabs.some((tab) => tab.open)) openTab();
      await drain();
    }
    const openTabs = tabs.filter((tab) => tab.open);
    if (openTabs.length > 0) {
      const stuck = savedWithoutOwner();
      if (stuck) {
        violate("saved batch left with no owner", stuck);
        break;
      }
    }
    if (openTabs.length > 0 && !jobs.some((each) => !each.cancelled && each.kind !== "action" && each.kind !== "server" && each.tab !== null && each.tab.open) && unsettled().length > 0) {
      const owned = jobs.some(
        (each) => !each.cancelled && each.kind !== "action" && each.kind !== "server" && each.tab !== null && each.tab.open,
      );
      if (!owned && (finalPhase || !jobs.some((each) => !each.cancelled && each.kind === "action"))) {
        violate("work left with no owner", `${unsettled().length} reports, nothing scheduled`);
        break;
      }
    }
  }

  const left = unsettled();
  if (exactCounts) {
    if (left.length > 0) violate("never delivered or counted", `${left.length} reports, first ${left[0]}`);
    for (const uuid of countedTwice) violate("counted twice", uuid);
  } else {
    const missing = [...allEvents].filter((uuid) => !settled(uuid)).length;
    if (missing > countedTotal) violate("never delivered or counted", `${missing - countedTotal} reports beyond the ${countedTotal} counted`);
  }

  return {
    seed,
    violations,
    tabs: tabs.length,
    events: allEvents.size,
    delivered: delivered.size,
    refused: refused.size,
    counted: exactCounts ? counted.size : countedTotal,
    lostAtClose: [...lostAtClose].filter((uuid) => !delivered.has(uuid)).length,
    posts,
    beacons,
    steps,
    aborted,
    refusedWrites,
    retryAfters,
    closes,
  };
}
