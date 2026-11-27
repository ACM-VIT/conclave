import * as currentOutbox from "../../src/app/lib/telemetry-outbox";

type Reply = { status: number; retryAfter: string | null; rejected?: number[] };

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
  races: number;
  throttles: number;
  lockRejects: number;
  readFailures: number;
  partials: number;
  partialRetries: number;
  postsWhileUnreadable: number;
  refusedMarks: number;
  lateWaits: number;
  shorterLateWaits: number;
  lateBeaconWaits: number;
  leaseHandoffs: number;
  lifecycleDuringConfirmation: number;
  savedAborts: number;
  savedRetries: number;
};

const START = Date.parse("2026-11-23T00:00:00.000Z");
const PROJECT = "phc_sim_project";
const SCHEDULE = [2000, 4000, 8000, 16000, 30000];
const MAX_WAIT_MS = 60_000;
const BEACON_CONFIRM_MS = 30_000;
const LEASE_MS = 16_000;
const THROTTLE_MS = 60_000;
const MAX_RACES = 300;
const BATCH_PREFIX = "conclave:telemetry:batch:";
const MARK_PREFIX = "conclave:telemetry:mark:";
const MAX_MARKS = 512;

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

type Job = { at: number; due: number; seq: number; tab: Tab | null; kind: "timer" | "reply" | "server" | "storage" | "action"; run: () => void; cancelled: boolean };

type Tab = { id: number; open: boolean; hidden: boolean; outbox: OutboxLike; throttledFrom: number | null; closedLossy?: boolean };

type Request = {
  key: string;
  uuids: string[];
  tab: Tab;
  keepalive: boolean;
  latest: boolean;
  done: boolean;
  arrived: boolean;
  aborted: boolean;
  sentAt: number;
  throttled: boolean;
};

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
  noLocks: boolean;
  raceRate: number;
  throttleRate: number;
  lockRejectRate: number;
  readFailRate: number;
  partialRate: number;
  activeMs: number;
};

const profileOf = (rng: () => number): Omit<Profile, "beaconLimitRate" | "noLocks" | "raceRate" | "throttleRate" | "lockRejectRate" | "readFailRate" | "partialRate"> => ({
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

export type ScriptedReply = { latency: number; status: number | null; retryAfter?: string; rejected?: number[] };

export type ScriptedAction =
  | { at: number; act: "refuseWritesFor"; ms: number }
  | { at: number; act: "unreadableFor"; ms: number }
  | {
      at: number;
      act: "open" | "emit" | "hide" | "show" | "close" | "refuseNext" | "rejectLock";
      tab: number;
      count?: number;
      throttled?: boolean;
      during?: number;
    };

export type Scenario = { profile?: Partial<Profile>; replies?: ScriptedReply[]; beacons?: ScriptedReply[]; actions?: ScriptedAction[] };

export async function simulate(
  seed: number,
  outboxModule: OutboxModule = currentOutbox as unknown as OutboxModule,
  trace?: (line: string) => void,
  scenario: Scenario = {},
): Promise<SimResult> {
  const rng = rngOf(seed);
  const beaconRng = rngOf(seed ^ 0x5bd1e995);
  const lockRng = rngOf(seed ^ 0x27d4eb2f);
  const raceRng = rngOf(seed ^ 0x2545f491);
  const lockRejectRng = rngOf(seed ^ 0x165667b1);
  const readFailRng = rngOf(seed ^ 0x3c6ef372);
  const partialRng = rngOf(seed ^ 0x6a09e667);
  const between = (low: number, high: number) => low + rng() * (high - low);
  const scriptedEnd = scenario.actions ? Math.max(...scenario.actions.map((action) => action.at)) + 1 : null;
  const profile: Profile = {
    ...profileOf(rng),
    beaconLimitRate: beaconRng() * 0.3,
    noLocks: lockRng() < 0.25,
    raceRate: raceRng() < 0.4 ? 0 : 0.005 + raceRng() * 0.05,
    throttleRate: raceRng() * 0.4,
    lockRejectRate: lockRejectRng() < 0.3 ? 0.02 + lockRejectRng() * 0.08 : 0,
    readFailRate: readFailRng() < 0.25 ? 0.05 + readFailRng() * 0.15 : 0,
    partialRate: partialRng() < 0.3 ? 0.1 + partialRng() * 0.3 : 0,
    ...(scriptedEnd === null ? {} : { activeMs: scriptedEnd }),
    ...scenario.profile,
  };
  const scriptedReplies = [...(scenario.replies ?? [])];
  const scriptedBeacons = [...(scenario.beacons ?? [])];
  const violations: Violation[] = [];
  let clock = START;
  const note = (line: string) => trace?.(`${((clock - START) / 1000).toFixed(3)} ${line}`);
  const violate = (kind: string, detail: string) => {
    note(`VIOLATION ${kind}: ${detail}`);
    if (violations.length < 20) violations.push({ at: clock - START, kind, detail });
  };

  const jobs: Job[] = [];
  let seq = 0;
  const schedule = (at: number, tab: Tab | null, kind: Job["kind"], run: () => void, due = at): Job => {
    const job: Job = { at: Math.max(at, clock), due, seq: ++seq, tab, kind, run, cancelled: false };
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
  type Learned = {
    key: string;
    tab: Tab;
    at: number;
    kind: "wait" | "failure" | "settled" | "refused";
    uuids: readonly string[];
    until: number;
    late: boolean;
    state: "pending" | "carried" | "lost";
  };
  const learned: Learned[] = [];
  const pendingLearned: Learned[] = [];
  const idToKey = new Map<string, string>();
  const eventToKey = new Map<string, string>();
  const batchKey = (uuids: string[]): string => {
    const keys = new Set(uuids.flatMap((uuid) => eventToKey.get(uuid) ?? []));
    const key = keys.values().next().value ?? [...uuids].sort().join(",");
    if (keys.size > 1) violate("combined events from existing batches", key);
    for (const uuid of uuids) eventToKey.set(uuid, key);
    return key;
  };
  let readFailures = 0;
  const lastHolder = new Map<string, Tab>();
  let closeFailed = false;
  let lastReadFailAt = Number.NEGATIVE_INFINITY;
  let refuseNext = 0;
  let rejectLocks = 0;
  let lockRejects = 0;
  let lastLockRejectAt = Number.NEGATIVE_INFINITY;
  const beaconedAt = new Map<string, { at: number; tab: Tab }>();
  let refusingUntil = 0;
  const failures = new Map<string, { count: number; at: number }>();
  const requests = new Map<string, Request[]>();
  let posts = 0;
  let beacons = 0;
  let aborted = 0;
  let refusedWrites = 0;
  let retryAfters = 0;
  let closes = 0;
  let races = 0;
  let throttles = 0;
  let ids = 0;
  let partialRetries = 0;
  let postsWhileUnreadable = 0;
  let refusedMarks = 0;
  let lateWaits = 0;
  let shorterLateWaits = 0;
  let lateBeaconWaits = 0;
  let leaseHandoffs = 0;
  let lifecycleDuringConfirmation = 0;
  let savedAborts = 0;
  let savedRetries = 0;
  const tabs: Tab[] = [];

  type SavedBatch = { id: string; notBefore?: number; nextTry?: number; leaseUntil?: number };
  type SavedMark = { delivered: boolean; notBefore: number };
  const items = new Map<string, string>();
  const writtenAt = new Map<string, number>();
  const savedBatches = new Map<string, SavedBatch | undefined>();
  const savedMarks = new Map<string, Map<string, SavedMark | undefined>>();
  const markKeys = new Set<string>();
  let itemKeys: string[] | null = null;
  const parsedOrUndefined = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const markBatchId = (key: string): string | null => {
    const rest = key.slice(MARK_PREFIX.length);
    const colon = rest.indexOf(":");
    return colon < 0 ? null : rest.slice(0, colon);
  };
  const indexItem = (key: string, value: string, parsed: unknown) => {
    itemKeys = null;
    if (key.startsWith(BATCH_PREFIX)) savedBatches.set(key, parsed as SavedBatch | undefined);
    if (key.startsWith(MARK_PREFIX)) {
      markKeys.add(key);
      const id = markBatchId(key);
      if (id !== null) {
        const marks = savedMarks.get(id) ?? new Map<string, SavedMark | undefined>();
        marks.set(key, parsed as SavedMark | undefined);
        savedMarks.set(id, marks);
      }
    }
    items.set(key, value);
  };
  const unindexItem = (key: string): boolean => {
    if (!items.delete(key)) return false;
    itemKeys = null;
    savedBatches.delete(key);
    if (markKeys.delete(key)) {
      const id = markBatchId(key);
      const marks = id === null ? undefined : savedMarks.get(id);
      marks?.delete(key);
      if (id !== null && marks?.size === 0) savedMarks.delete(id);
    }
    return true;
  };
  const clearItems = () => {
    items.clear();
    itemKeys = null;
    savedBatches.clear();
    savedMarks.clear();
    markKeys.clear();
  };
  let closingTab: Tab | null = null;
  const notifyOthers = (writer: Tab) => {
    for (const tab of tabs) {
      if (tab !== writer && tab.open) schedule(clock + between(0, 30), tab, "storage", () => tab.outbox.replaySaved());
    }
  };
  let racePlanned: { reader: Tab; other: Tab; done: boolean } | null = null;
  let interleaving = false;
  let racedThisStep = false;
  let unreadableUntil = 0;
  const readFails = () => clock < unreadableUntil;
  const unreadable = () => {
    readFailures += 1;
    lastReadFailAt = clock;
    if (closingTab) closeFailed = true;
    note("storage read failed");
    return new DOMException("The storage is unavailable.", "SecurityError");
  };
  const storageFor = (tab: Tab): Storage => ({
    get length() {
      if (readFails()) throw unreadable();
      return items.size;
    },
    key: (index: number) => (itemKeys ??= [...items.keys()])[index] ?? null,
    getItem: (key: string) => {
      if (readFails()) throw unreadable();
      const value = items.get(key) ?? null;
      if (value !== null && racePlanned?.reader === tab && !racePlanned.done) {
        racePlanned.done = true;
        interleave(tab, racePlanned.other, "replay");
      } else if (
        !interleaving &&
        !racedThisStep &&
        racePlanned === null &&
        races < MAX_RACES &&
        profile.raceRate > 0 &&
        raceRng() < profile.raceRate
      ) {
        racedThisStep = true;
        const others = tabs.filter((other) => other.open && other !== tab);
        if (others.length > 0) interleave(tab, others[Math.floor(raceRng() * others.length)], raceRng() < 0.6 ? "replay" : "lifecycle");
      }
      return value;
    },
    setItem: (key: string, value: string) => {
      const markedKey = key.startsWith(MARK_PREFIX) ? (idToKey.get(key.slice(MARK_PREFIX.length).split(":")[0]) ?? null) : null;
      const marked =
        markedKey === null
          ? []
          : learned.filter(
              (item) => item.tab === tab && item.key === markedKey && item.at === clock && item.state !== "carried" && item.state !== "lost",
            );
      if (refuseNext > 0 || profile.noLocks || clock < refusingUntil || rng() < profile.refuseRate) {
        if (refuseNext > 0) refuseNext -= 1;
        refusedWrites += 1;
        if (markedKey !== null) refusedMarks += 1;
        for (const item of marked) item.state = "lost";
        if (closingTab === tab) {
          closeFailed = true;
          try {
            for (const event of (JSON.parse(value) as { events: Array<{ uuid: string }> }).events) lostAtClose.add(event.uuid);
          } catch {}
        }
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      }
      const parsed = key.startsWith(BATCH_PREFIX) || key.startsWith(MARK_PREFIX) ? parsedOrUndefined(value) : undefined;
      if (key.startsWith(BATCH_PREFIX)) {
        try {
          const batch = parsed as { id: string; events: Array<{ uuid: string }> };
          idToKey.set(batch.id, batchKey(batch.events.map((event) => event.uuid)));
        } catch {}
      }
      indexItem(key, value, parsed);
      writtenAt.set(key, clock);
      if (trace) note(`tab${tab.id} saved ${key.slice(-12)} ${value.replace(/"events":\[.*?\],/, "")}`);
      notifyOthers(tab);
    },
    removeItem: (key: string) => {
      if (unindexItem(key)) {
        note(`tab${tab.id} removed ${key.slice(-12)}`);
        notifyOthers(tab);
      }
    },
    clear: clearItems,
  });

  const storedNow = (key: string) => {
    for (const item of savedBatches.keys()) if (idToKey.get(item.slice(BATCH_PREFIX.length)) === key) return true;
    return false;
  };
  const applyFailure = (item: Learned) => {
    const previous = failures.get(item.key);
    failures.set(item.key, { count: (previous?.count ?? 0) + 1, at: Math.max(previous?.at ?? 0, item.at) });
  };
  const carry = (item: Learned) => {
    item.state = "carried";
    if (item.kind === "failure") applyFailure(item);
  };
  const learn = (tab: Tab, key: string, kind: Learned["kind"], until: number, late: boolean, uuids: readonly string[] = []) => {
    const item: Learned = { key, tab, at: clock, kind, until, late, uuids, state: "pending" };
    if (!late && !storedNow(key)) carry(item);
    learned.push(item);
    pendingLearned.push(item);
  };
  const waiting: Array<{ tab: Tab; run: () => Promise<void> }> = [];
  let held = false;
  let grantAtOnce = false;
  const pump = () => {
    while (!held && waiting.length > 0) {
      const next = waiting.shift() as { tab: Tab; run: () => Promise<void> };
      if (!next.tab.open) continue;
      held = true;
      void (grantAtOnce ? next.run() : Promise.resolve().then(next.run))
        .catch(() => {})
        .finally(() => {
          held = false;
          pump();
        });
    }
  };

  const knownTo = (item: Learned, sender: Tab) => item.state === "carried" || item.tab === sender;
  const settledFor = (key: string, sender: Tab) => learned.some((item) => item.kind === "settled" && item.key === key && knownTo(item, sender));
  const checkSend = (key: string, uuids: string[], how: "post" | "beacon", sender: Tab) => {
    if (settledFor(key, sender)) violate("sent after it was settled", `${how} of ${key}`);
    const sending = new Set(uuids);
    const refusedAgain = learned.find((item) => item.kind === "refused" && knownTo(item, sender) && item.uuids.some((uuid) => sending.has(uuid)));
    if (refusedAgain) violate("sent an event refused for good again", `${how} of ${key}`);
    const known = learned.filter((item) => item.key === key && knownTo(item, sender));
    if (known.some((item) => item.kind === "refused") && !refusedAgain) partialRetries += 1;
    const until = Math.max(0, ...known.filter((item) => item.kind === "wait").map((item) => item.until));
    if (clock < until) violate("sent before its Retry-After", `${how} of ${key} ${until - clock} ms early`);
    const beaconed = beaconedAt.get(key);
    if (beaconed && clock - beaconed.at < BEACON_CONFIRM_MS) {
      violate("sent again before its beacon is confirmed", `${how} of ${key} ${clock - beaconed.at} ms after its beacon`);
    }
    if (how === "post") {
      const open = (requests.get(key) ?? []).filter((request) => !request.done && request.tab.open);
      const outlivedLease = (request: Request) => request.throttled && clock - request.sentAt >= LEASE_MS;
      if (open.some((request) => request.tab !== sender && outlivedLease(request))) leaseHandoffs += 1;
      if (open.some((request) => !outlivedLease(request))) violate("two sends of one batch in flight", key);
    }
    const failed = failures.get(key);
    if (failed && failed.count > 0) {
      const gap = SCHEDULE[Math.min(failed.count - 1, SCHEDULE.length - 1)];
      if (clock - failed.at < gap) violate("sent sooner than its backoff", `${key} after ${clock - failed.at} ms, needs ${gap}`);
    }
  };
  const failed = (request: Request) => {
    if (!request.latest) return;
    learn(request.tab, request.key, "failure", 0, false);
  };

  const network = (tab: Tab) => (body: string, keepalive: boolean, signal?: AbortSignal): Promise<Reply> => {
    const uuids = (JSON.parse(body) as { batch: Array<{ uuid: string }> }).batch.map((event) => event.uuid);
    const key = batchKey(uuids);
    checkSend(key, uuids, "post", tab);
    if (readFails()) postsWhileUnreadable += 1;
    if (storedNow(key) && failures.has(key)) savedRetries += 1;
    note(`tab${tab.id} post ${key.slice(0, 40)} keepalive=${keepalive}`);
    posts += 1;
    for (const uuid of uuids) lastHolder.set(uuid, tab);
    const earlier = requests.get(key) ?? [];
    for (const request of earlier) request.latest = false;
    const request: Request = {
      key,
      uuids,
      tab,
      keepalive,
      latest: true,
      done: false,
      arrived: false,
      aborted: false,
      sentAt: clock,
      throttled: tab.throttledFrom !== null,
    };
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
    const outcome: { status: number | null; retryAfter: string | null; rejected?: number[] } = scripted
      ? { status: scripted.status, retryAfter: scripted.retryAfter ?? null, rejected: scripted.rejected }
      : kindRoll < profile.okRate
        ? { status: 200, retryAfter: null }
        : kindRoll < profile.okRate + profile.refuseBodyRate
          ? { status: 400, retryAfter: null }
          : rng() < profile.limitRate
            ? { status: rng() < 0.7 ? 429 : 503, retryAfter: String(1 + Math.floor(rng() * 120)) }
            : rng() < profile.errorRate
              ? { status: null, retryAfter: null }
              : { status: rng() < 0.5 ? 503 : 500, retryAfter: rng() < profile.waitRate ? String(1 + Math.floor(rng() * 90)) : null };
    if (!scripted && outcome.status !== null && (outcome.status === 429 || outcome.status >= 500) && uuids.length > 1 && profile.partialRate > 0 && partialRng() < profile.partialRate) {
      const rejected = uuids.flatMap((_, index) => (partialRng() < 0.5 ? [index] : []));
      if (rejected.length > 0 && rejected.length < uuids.length) outcome.rejected = rejected;
    }
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
          if (storedNow(key)) savedAborts += 1;
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
        if (outcome.status !== 200) for (const index of outcome.rejected ?? []) if (!delivered.has(uuids[index])) refused.add(uuids[index]);
      });
      schedule(sentAt + latency, tab, "reply", () => {
        if (!tab.open) {
          request.done = true;
          if (tab.closedLossy) {
            const stored = storedUuids();
            for (const uuid of uuids) if (!delivered.has(uuid) && !stored.has(uuid)) lostAtClose.add(uuid);
          }
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
        if (status === 200 || status === 400) learn(tab, key, "settled", 0, !request.latest);
        if (status === 429 || status >= 500) {
          if (outcome.retryAfter !== null) learnWait(tab, key, outcome.retryAfter, !request.latest);
          failed(request);
        }
        const rejectedUuids = (outcome.rejected ?? []).map((index) => uuids[index]);
        if (rejectedUuids.length > 0) learn(tab, key, "refused", 0, !request.latest, rejectedUuids);
        note(`tab${tab.id} reply ${status} ra=${outcome.retryAfter} rejected=${outcome.rejected?.length ?? 0} for ${key.slice(0, 40)} latest=${request.latest}`);
        finish(() => resolve({ status, retryAfter: outcome.retryAfter, ...(outcome.rejected ? { rejected: outcome.rejected } : {}) }));
      });
    });
  };

  const learnWait = (tab: Tab, key: string, retryAfter: string, late: boolean) => {
    retryAfters += 1;
    const until = clock + Math.min(Number(retryAfter) * 1000, MAX_WAIT_MS);
    if (late) {
      lateWaits += 1;
      if (learned.some((item) => item.key === key && item.kind === "wait" && item.state === "carried" && item.until > until)) {
        shorterLateWaits += 1;
      }
    }
    learn(tab, key, "wait", until, late);
  };
  const beaconWait = (tab: Tab, key: string, sentAt: number, retryAfter: string) => {
    const sentSince = (requests.get(key) ?? []).some((request) => request.sentAt > sentAt);
    if (sentSince) lateBeaconWaits += 1;
    learnWait(tab, key, retryAfter, sentSince);
  };
  const beaconFor = (tab: Tab) => (body: string): Promise<Reply | null> | null => {
    const uuids = (JSON.parse(body) as { batch: Array<{ uuid: string }> }).batch.map((event) => event.uuid);
    const key = batchKey(uuids);
    checkSend(key, uuids, "beacon", tab);
    const scripted = scriptedBeacons.shift();
    if (!scripted && rng() < profile.beaconRefuseRate) return null;
    const sentAt = clock;
    beaconedAt.set(key, { at: clock, tab });
    beacons += 1;
    if (scripted) {
      return new Promise<Reply | null>((resolve) => {
        schedule(sentAt + scripted.latency, tab, "reply", () => {
          if (!tab.open || scripted.status === null) return;
          const status = scripted.status;
          const retryAfter = scripted.retryAfter ?? null;
          if (status >= 200 && status < 300) for (const uuid of uuids) delivered.add(uuid);
          if (status >= 200 && status < 300) learn(tab, key, "settled", 0, (requests.get(key) ?? []).some((request) => request.sentAt > sentAt));
          if (retryAfter !== null && (status === 429 || status >= 500)) beaconWait(tab, key, sentAt, retryAfter);
          note(`tab${tab.id} beacon answered ${status} ra=${retryAfter} for ${key.slice(0, 40)}`);
          resolve({ status, retryAfter });
        });
      });
    }
    if (beaconRng() < profile.beaconLimitRate) {
      const status = beaconRng() < 0.7 ? 429 : 503;
      const retryAfter = String(1 + Math.floor(beaconRng() * 120));
      const answeredAt = clock + 20 + beaconRng() * 780;
      return new Promise<Reply | null>((resolve) => {
        schedule(answeredAt, tab, "reply", () => {
          if (!tab.open) return;
          beaconWait(tab, key, sentAt, retryAfter);
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
    const tab: Tab = { id: tabs.length + 1, open: true, hidden: false, outbox: undefined as unknown as OutboxLike, throttledFrom: null };
    const deps = {
      token: PROJECT,
      now: () => clock,
      setTimer: (run: () => void, ms: number) => schedule(throttledAt(tab, clock + ms), tab, "timer", run, clock + ms),
      clearTimer: (job: unknown) => {
        if (job) (job as Job).cancelled = true;
      },
      post: network(tab),
      beacon: beaconFor(tab),
      newId: () => `sim-${seed}-${++ids}`,
      store: outboxModule.createBatchStore(() => storageFor(tab)),
      lock: (granted: () => Promise<void>) => {
        if (!profile.noLocks && (rejectLocks > 0 || (profile.lockRejectRate > 0 && lockRejectRng() < profile.lockRejectRate))) {
          if (rejectLocks > 0) rejectLocks -= 1;
          lockRejects += 1;
          lastLockRejectAt = clock;
          note(`tab${tab.id} lock request rejected`);
          return Promise.reject(new DOMException("The lock request was aborted.", "AbortError"));
        }
        const run = granted;
        if (profile.noLocks) {
          void run();
          return;
        }
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
      lastHolder.set(uuid, tab);
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
  const storedUuids = () =>
    new Set(
      [...items.entries()].flatMap(([key, text]) => {
        if (!key.startsWith(BATCH_PREFIX)) return [];
        try {
          return (JSON.parse(text) as { events: Array<{ uuid: string }> }).events.map((event) => event.uuid);
        } catch {
          return [];
        }
      }),
    );
  const closeTab = (tab: Tab) => {
    note(`tab${tab.id} closes`);
    closes += 1;
    closingTab = tab;
    closeFailed = false;
    tab.outbox.flushForUnload();
    closingTab = null;
    tab.open = false;
    tab.closedLossy = closeFailed;
    if (closeFailed) {
      const stored = storedUuids();
      const sending = new Set(
        [...requests.values()].flat().flatMap((request) => (!request.done && (request.keepalive || request.tab.open) ? request.uuids : [])),
      );
      for (const [uuid, holder] of lastHolder) {
        if (holder === tab && !delivered.has(uuid) && !stored.has(uuid) && !sending.has(uuid)) lostAtClose.add(uuid);
      }
    }
    for (const item of learned) if (item.tab === tab && item.state === "pending") item.state = "lost";
    for (const job of jobs) if (job.tab === tab && job.kind !== "reply") job.cancelled = true;
  };
  function throttledAt(tab: Tab, due: number): number {
    if (tab.throttledFrom === null) return due;
    return tab.throttledFrom + Math.ceil(Math.max(due - tab.throttledFrom, 0) / THROTTLE_MS) * THROTTLE_MS;
  }
  const throttle = (tab: Tab) => {
    if (tab.throttledFrom !== null) return;
    tab.throttledFrom = clock;
    throttles += 1;
    for (const job of jobs) if (job.tab === tab && job.kind === "timer" && !job.cancelled) job.at = throttledAt(tab, job.due);
    for (const list of requests.values()) for (const request of list) if (request.tab === tab && !request.done) request.throttled = true;
  };
  const unthrottle = (tab: Tab) => {
    if (tab.throttledFrom === null) return;
    tab.throttledFrom = null;
    for (const job of jobs) if (job.tab === tab && job.kind === "timer" && !job.cancelled) job.at = Math.max(clock, job.due);
  };
  const showTab = (tab: Tab) => {
    if (!tab.open) return;
    note(`tab${tab.id} shows`);
    tab.hidden = false;
    unthrottle(tab);
    tab.outbox.replaySaved();
  };
  const hideTab = (tab: Tab, throttled: boolean) => {
    note(`tab${tab.id} hides${throttled ? ", its timers throttled" : ""}`);
    tab.hidden = true;
    if ([...beaconedAt.values()].some((beacon) => beacon.tab === tab && clock - beacon.at < BEACON_CONFIRM_MS)) {
      lifecycleDuringConfirmation += 1;
    }
    if (throttled) throttle(tab);
    tab.outbox.flushForUnload();
  };
  function interleave(reader: Tab, other: Tab, move: "replay" | "lifecycle"): void {
    if (!other.open) return;
    races += 1;
    note(`tab${other.id} acts between a read of tab${reader.id} and what tab${reader.id} writes next: ${move}`);
    interleaving = true;
    try {
      if (move === "replay") {
        grantAtOnce = true;
        try {
          other.outbox.replaySaved();
          pump();
        } finally {
          grantAtOnce = false;
        }
      } else if (other.hidden) {
        other.outbox.flushForUnload();
      } else {
        hideTab(other, false);
        schedule(clock + between(1000, 60_000), other, "action", () => showTab(other));
      }
    } finally {
      interleaving = false;
    }
  }
  const act = () => {
    if (!active()) return;
    if (profile.readFailRate > 0 && readFailRng() < profile.readFailRate) {
      unreadableUntil = clock + 1000 + readFailRng() * 9000;
      note(`storage cannot be read until ${((unreadableUntil - START) / 1000).toFixed(3)}`);
    }
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
        hideTab(tab, raceRng() < profile.throttleRate);
        const shownAt = clock + between(1000, 120_000);
        schedule(shownAt, tab, "action", () => showTab(tab));
        const frozenAt = clock + between(5000, 60_000);
        if (frozenAt < shownAt && raceRng() < 0.5) {
          schedule(frozenAt, tab, "action", () => {
            if (!tab.hidden) return;
            note(`tab${tab.id} freezes`);
            tab.outbox.flushForUnload();
          });
        }
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
      schedule(clock + between(1000, 90_000), tab, "action", () => showTab(tab));
    } else if (roll < 0.85 && open.length > 0) {
      closeTab(open[Math.floor(rng() * open.length)]);
    }
    schedule(clock + between(5000, 60_000), null, "action", act);
  };

  const drain = () => new Promise<void>((resolve) => process.nextTick(resolve));
  const settled = (uuid: string) => delivered.has(uuid) || refused.has(uuid) || lostAtClose.has(uuid);
  const unsettled = () => [...allEvents].filter((uuid) => !settled(uuid) && !counted.has(uuid));
  const GRACE_MS = 1000;
  const savedWithoutOwner = (): string | null => {
    for (const [key, saved] of savedBatches) {
      if (saved === undefined) continue;
      const marks = [...(savedMarks.get(saved.id) ?? [])].flatMap(([markKey, mark]) =>
        mark === undefined ? [] : [{ ...mark, writtenAt: writtenAt.get(markKey) ?? 0 }],
      );
      const identity = idToKey.get(saved.id);
      const settledAt = marks.filter((mark) => mark.delivered).map((mark) => mark.writtenAt);
      const due =
        settledAt.length > 0
          ? Math.min(...settledAt)
          : Math.max(
              saved.notBefore ?? 0,
              saved.nextTry ?? 0,
              saved.leaseUntil ?? 0,
              writtenAt.get(key) ?? 0,
              ...marks.map((mark) => mark.notBefore),
              ...learned.filter((item) => item.kind === "wait" && item.tab.open && item.key === identity).map((item) => item.until),
            );
      if (clock - due <= GRACE_MS) continue;
      if (identity && requests.get(identity)?.some((request) => !request.done && request.tab.open)) continue;
      return `${key.slice("conclave:telemetry:batch:".length)} due ${clock - due} ms ago`;
    }
    return null;
  };

  if (scenario.actions) {
    for (const action of scenario.actions) {
      schedule(START + action.at, null, "action", () => {
        if (action.act === "refuseWritesFor") {
          refusingUntil = clock + action.ms;
          return;
        }
        if (action.act === "unreadableFor") {
          unreadableUntil = clock + action.ms;
          return;
        }
        const tab = tabs[action.tab - 1];
        if (action.act === "open") openTab();
        else if (!tab?.open) return;
        else if (action.act === "emit") emit(tab, action.count ?? 1);
        else if (action.act === "hide") {
          const other = action.during === undefined ? undefined : tabs[action.during - 1];
          racePlanned = other ? { reader: tab, other, done: false } : null;
          hideTab(tab, action.throttled ?? false);
          if (racePlanned && !racePlanned.done) {
            racePlanned.done = true;
            interleave(tab, racePlanned.other, "replay");
          }
          racePlanned = null;
        } else if (action.act === "show") showTab(tab);
        else if (action.act === "refuseNext") refuseNext += action.count ?? 1;
        else if (action.act === "rejectLock") rejectLocks += action.count ?? 1;
        else closeTab(tab);
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
    racedThisStep = false;
    let stillPending = 0;
    for (const item of pendingLearned) {
      if (item.state !== "pending") continue;
      if (item.at < clock) carry(item);
      else pendingLearned[stillPending++] = item;
    }
    pendingLearned.length = stillPending;
    job.run();
    await drain();
    steps += 1;
    if (!active() && !finalPhase && !jobs.some((each) => !each.cancelled && each.kind !== "action")) {
      finalPhase = true;
      if (!tabs.some((tab) => tab.open)) openTab();
      await drain();
    }
    const markCount = markKeys.size;
    if (markCount > MAX_MARKS) {
      violate("marks grew past their bound", `${markCount}`);
      break;
    }
    const openTabs = tabs.filter((tab) => tab.open);
    if (openTabs.some((tab) => tab.throttledFrom === null) && clock - lastLockRejectAt > 35_000 && clock - lastReadFailAt > 35_000) {
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

  const leftInStorage = [...items.keys()].filter((key) => key.startsWith("conclave:telemetry:batch:"));
  if (leftInStorage.length > 0) violate("saved batch left in storage at the end", leftInStorage[0].slice("conclave:telemetry:batch:".length));
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
    races,
    throttles,
    lockRejects,
    readFailures,
    partials: learned.filter((item) => item.kind === "refused").length,
    partialRetries,
    postsWhileUnreadable,
    refusedMarks,
    lateWaits,
    shorterLateWaits,
    lateBeaconWaits,
    leaseHandoffs,
    lifecycleDuringConfirmation,
    savedAborts,
    savedRetries,
  };
}
