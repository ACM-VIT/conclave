import type { Scenario, SimResult } from "./outbox-sim";

type Conditions = Partial<Omit<SimResult, "seed" | "violations">>;
type Coverage = { [Key in keyof Conditions]-?: Required<Pick<Conditions, Key>> }[keyof Conditions];

type ThreadCase = {
  name: string;
  thread: string;
  head: string;
  seed: number;
  scenario: Scenario;
  covers: Coverage;
  posts?: number;
};

export const REGRESSION_SEEDS: readonly number[] = [
  15, 18, 23, 25, 28, 41, 42, 43, 49, 51, 54, 58, 62, 67, 68, 69, 75, 77, 81, 89, 102, 108, 109, 113, 119, 122, 125,
  133, 134, 141, 145, 152, 162, 163, 178, 179, 181, 190, 201, 205, 219, 229, 234, 235, 252, 253, 254, 255, 259, 262,
  264, 283, 284, 293, 297, 298, 299,
];

const quiet = {
  refuseRate: 0,
  beaconRefuseRate: 1,
  beaconLossRate: 0,
  beaconLimitRate: 0,
  noLocks: false,
  raceRate: 0,
  throttleRate: 0,
  lockRejectRate: 0,
  readFailRate: 0,
  partialRate: 0,
  maxTabs: 3,
};

export const PARTIAL_RETRY: Scenario = {
  profile: quiet,
  actions: [
    { at: 0, act: "open", tab: 1 },
    { at: 1000, act: "emit", tab: 1, count: 2 },
  ],
  replies: [
    { latency: 100, status: 503, retryAfter: "60", rejected: [0] },
    { latency: 100, status: 200 },
  ],
};

export const PARTIAL_HANDOFF: Scenario = {
  ...PARTIAL_RETRY,
  actions: [
    ...(PARTIAL_RETRY.actions ?? []),
    { at: 2000, act: "hide", tab: 1 },
    { at: 2050, act: "rejectLock", tab: 1 },
    { at: 3000, act: "open", tab: 2 },
    { at: 4000, act: "close", tab: 1 },
  ],
};

export const KEEPALIVE_REFUSAL: Scenario = {
  profile: { ...quiet, beaconRefuseRate: 0 },
  actions: [
    { at: 0, act: "open", tab: 1 },
    { at: 1000, act: "emit", tab: 1, count: 2 },
    { at: 1500, act: "hide", tab: 1 },
    { at: 3000, act: "show", tab: 1 },
  ],
  beacons: [{ latency: 200, status: 503, retryAfter: "1", rejected: [0] }],
  replies: [{ latency: 100, status: 200 }],
};

export const THREAD_CASES: ThreadCase[] = [
  {
    name: "a keepalive answer that refuses an event keeps it out of every later send",
    covers: { keepaliveRefusals: 1 },
    thread: "https://github.com/ACM-VIT/conclave/pull/265#discussion_r4714611034",
    head: "5d046b3e",
    seed: 4714611034,
    scenario: KEEPALIVE_REFUSAL,
    posts: 1,
  },
  {
    name: "a keepalive answer that refuses an event of a batch held in memory lands while the batch is sent again, and the event is not sent after",
    covers: { keepaliveRefusals: 1, refusedWrites: 1 },
    thread: "https://github.com/ACM-VIT/conclave/pull/265#discussion_r4714611034",
    head: "5d046b3e",
    seed: 4714611034,
    scenario: {
      profile: { ...quiet, refuseRate: 1, beaconRefuseRate: 0 },
      actions: [
        { at: 0, act: "open", tab: 1 },
        { at: 1000, act: "emit", tab: 1, count: 2 },
        { at: 1500, act: "hide", tab: 1 },
        { at: 2000, act: "show", tab: 1 },
      ],
      beacons: [{ latency: 40_000, status: 503, retryAfter: "1", rejected: [0] }],
      replies: [
        { latency: 20_000, status: 503 },
        { latency: 100, status: 200 },
      ],
    },
    posts: 2,
  },
  {
    name: "ordinary backoff does not restart when a partial reply shrinks the batch",
    thread: "https://github.com/ACM-VIT/conclave/pull/265",
    head: "d7ee9bc24",
    seed: 4661287478,
    posts: 3,
    covers: { partialRetries: 1 },
    scenario: {
      ...PARTIAL_RETRY,
      replies: [
        { latency: 100, status: 503 },
        { latency: 100, status: 503, rejected: [0] },
        { latency: 100, status: 200 },
      ],
    },
  },
  {
    name: "a partial reply holds the remaining events to the same Retry-After",
    covers: { partialRetries: 1, retryAfters: 1 },
    thread: "https://github.com/ACM-VIT/conclave/pull/265#discussion_r4690021085",
    head: "d7ee9bc24",
    seed: 4661287478,
    posts: 2,
    scenario: PARTIAL_RETRY,
  },
  {
    name: "a partial reply holds the remaining events after another tab takes over",
    covers: { partialRetries: 1, retryAfters: 1, lockRejects: 1, closes: 1, savedRetries: 1 },
    thread: "https://github.com/ACM-VIT/conclave/pull/265#discussion_r4690021085",
    head: "d7ee9bc24",
    seed: 4661287478,
    posts: 2,
    scenario: PARTIAL_HANDOFF,
  },
  {
    name: "a page that opens while storage is full still replays and removes what was saved",
    covers: { refusedWrites: 1, closes: 1 },
    thread: "https://github.com/ACM-VIT/conclave/pull/265#discussion_r4689976665",
    head: "61dc0cf5",
    seed: 2026112504,
    scenario: {
      profile: quiet,
      actions: [
        { at: 0, act: "open", tab: 1 },
        { at: 1000, act: "emit", tab: 1, count: 2 },
        { at: 1500, act: "hide", tab: 1 },
        { at: 2000, act: "close", tab: 1 },
        { at: 2500, act: "refuseWritesFor", ms: 120_000 },
        { at: 3000, act: "open", tab: 2 },
      ],
      replies: [
        { latency: 30_000, status: null },
        { latency: 100, status: 200 },
        { latency: 100, status: 200 },
        { latency: 100, status: 200 },
      ],
    },
  },
  {
    name: "a report that was never saved goes out while storage cannot be read",
    covers: { readFailures: 1, postsWhileUnreadable: 1 },
    thread: "https://github.com/ACM-VIT/conclave/pull/265#discussion_r4689976674",
    head: "61dc0cf5",
    seed: 2026112504,
    scenario: {
      profile: quiet,
      actions: [
        { at: 0, act: "open", tab: 1 },
        { at: 500, act: "unreadableFor", ms: 7000 },
        { at: 750, act: "show", tab: 1 },
        { at: 1000, act: "emit", tab: 1, count: 2 },
      ],
      replies: [
        { latency: 100, status: 200 },
        { latency: 100, status: 200 },
      ],
    },
  },
  {
    name: "a delivered answer whose mark write and lock request both fail is never sent again by its tab",
    covers: { refusedMarks: 1, lockRejects: 1 },
    thread: "https://github.com/ACM-VIT/conclave/pull/265#discussion_r4689976680",
    head: "61dc0cf5",
    seed: 2026112504,
    posts: 2,
    scenario: {
      profile: quiet,
      actions: [
        { at: 0, act: "open", tab: 1 },
        { at: 1000, act: "emit", tab: 1, count: 2 },
        { at: 1500, act: "hide", tab: 1 },
        { at: 2000, act: "show", tab: 1 },
        { at: 3500, act: "refuseNext", tab: 1, count: 1 },
        { at: 3500, act: "rejectLock", tab: 1, count: 1 },
      ],
      replies: [
        { latency: 3000, status: 200 },
        { latency: 100, status: 200 },
        { latency: 100, status: 200 },
        { latency: 100, status: 200 },
      ],
    },
  },
  {
    name: "events an answer refused are never uploaded again when its lock request is refused",
    covers: { partialRetries: 1, lockRejects: 1 },
    thread: "https://github.com/ACM-VIT/conclave/pull/265#discussion_r4690021085",
    head: "61dc0cf5",
    seed: 2026112504,
    posts: 3,
    scenario: {
      profile: quiet,
      actions: [
        { at: 0, act: "open", tab: 1 },
        { at: 1000, act: "emit", tab: 1, count: 6 },
        { at: 1500, act: "hide", tab: 1 },
        { at: 2000, act: "show", tab: 1 },
        { at: 3500, act: "rejectLock", tab: 1, count: 1 },
      ],
      replies: [
        { latency: 100, status: 200 },
        { latency: 3000, status: 503, rejected: [0] },
        { latency: 100, status: 200 },
        { latency: 100, status: 200 },
        { latency: 100, status: 200 },
      ],
    },
  },
  {
    name: "a delivered answer whose lock request is refused still reaches every send, and nothing is sent again",
    covers: { lockRejects: 1 },
    thread: "Sol delta review of #265 at ee08a3c9, finding 1 (200)",
    head: "ee08a3c9",
    seed: 2026112504,
    posts: 2,
    scenario: {
      profile: { ...quiet, lockRejectRate: 0 },
      actions: [
        { at: 0, act: "open", tab: 1 },
        { at: 1000, act: "emit", tab: 1, count: 2 },
        { at: 1500, act: "hide", tab: 1 },
        { at: 2000, act: "show", tab: 1 },
        { at: 3500, act: "rejectLock", tab: 1, count: 1 },
      ],
      replies: [
        { latency: 3000, status: 200 },
        { latency: 100, status: 200 },
        { latency: 100, status: 200 },
        { latency: 100, status: 200 },
      ],
    },
  },
  {
    name: "a Retry-After whose lock request is refused still holds every send, and nothing goes before it",
    covers: { lockRejects: 1, retryAfters: 1, savedRetries: 1 },
    thread: "Sol delta review of #265 at ee08a3c9, finding 1 (503 with Retry-After)",
    head: "ee08a3c9",
    seed: 2026112504,
    posts: 3,
    scenario: {
      profile: { ...quiet, lockRejectRate: 0 },
      actions: [
        { at: 0, act: "open", tab: 1 },
        { at: 1000, act: "emit", tab: 1, count: 2 },
        { at: 1500, act: "hide", tab: 1 },
        { at: 2000, act: "show", tab: 1 },
        { at: 3500, act: "rejectLock", tab: 1, count: 1 },
      ],
      replies: [
        { latency: 3000, status: 503, retryAfter: "60" },
        { latency: 100, status: 200 },
        { latency: 100, status: 200 },
        { latency: 100, status: 200 },
      ],
    },
  },
  {
    name: "a batch whose answer meets a run of refused lock requests is never stranded",
    covers: { lockRejects: 8, savedRetries: 1 },
    thread: "Sol delta review of #265 at ee08a3c9, finding 1 (expiry)",
    head: "ee08a3c9",
    seed: 2026112504,
    posts: 3,
    scenario: {
      profile: { ...quiet, lockRejectRate: 0 },
      actions: [
        { at: 0, act: "open", tab: 1 },
        { at: 1000, act: "emit", tab: 1, count: 2 },
        { at: 1500, act: "hide", tab: 1 },
        { at: 2000, act: "show", tab: 1 },
        { at: 3500, act: "rejectLock", tab: 1, count: 8 },
      ],
      replies: [
        { latency: 3000, status: 503 },
        { latency: 100, status: 200 },
        { latency: 100, status: 200 },
        { latency: 100, status: 200 },
      ],
    },
  },
  {
    name: "a late, shorter Retry-After never brings the new owner's wait forward",
    covers: { shorterLateWaits: 1, leaseHandoffs: 1 },
    thread: "Neon final review of #265 at 71254939, minor 1 (never-earlier guard)",
    head: "71254939",
    seed: 2026112504,
    scenario: {
      profile: quiet,
      actions: [
        { at: 0, act: "open", tab: 1 },
        { at: 1000, act: "emit", tab: 1, count: 2 },
        { at: 6500, act: "hide", tab: 1 },
        { at: 7000, act: "show", tab: 1 },
        { at: 9000, act: "open", tab: 2 },
        { at: 10_000, act: "hide", tab: 1, throttled: true },
      ],
      replies: [
        { latency: 100, status: 503 },
        { latency: 30_000, status: 429, retryAfter: "1" },
        { latency: 100, status: 200 },
        { latency: 100, status: 429, retryAfter: "60" },
        { latency: 100, status: 200 },
        { latency: 100, status: 200 },
      ],
    },
  },
  {
    name: "a keepalive send answered after the batch was claimed again still holds that claim to its Retry-After",
    covers: { lateBeaconWaits: 1 },
    thread: "Neon final review of #265 at 71254939, minor 1 (late keepalive answer)",
    head: "71254939",
    seed: 2026112504,
    scenario: {
      profile: { ...quiet, beaconRefuseRate: 0 },
      actions: [
        { at: 0, act: "open", tab: 1 },
        { at: 1000, act: "emit", tab: 1, count: 2 },
        { at: 1500, act: "hide", tab: 1 },
        { at: 3000, act: "open", tab: 2 },
      ],
      beacons: [{ latency: 40_000, status: 429, retryAfter: "60" }],
      replies: [
        { latency: 100, status: 200 },
        { latency: 20_000, status: 503 },
        { latency: 100, status: 200 },
        { latency: 100, status: 200 },
      ],
    },
  },
  {
    name: "a late Retry-After still holds the new owner when storage refuses another batch's write right after it",
    covers: { lateWaits: 1, leaseHandoffs: 1, refusedWrites: 1 },
    thread: "https://github.com/ACM-VIT/conclave/pull/265#discussion_r4688169874",
    head: "57a8f5b0",
    seed: 2026112504,
    scenario: {
      profile: quiet,
      actions: [
        { at: 0, act: "open", tab: 1 },
        { at: 1000, act: "emit", tab: 1, count: 2 },
        { at: 6500, act: "hide", tab: 1 },
        { at: 7000, act: "show", tab: 1 },
        { at: 9000, act: "open", tab: 2 },
        { at: 10_000, act: "hide", tab: 1, throttled: true },
        { at: 33_300, act: "refuseNext", tab: 2 },
        { at: 33_300, act: "emit", tab: 2, count: 1 },
        { at: 33_350, act: "hide", tab: 2 },
        { at: 33_500, act: "show", tab: 2 },
      ],
      replies: [
        { latency: 100, status: 503 },
        { latency: 30_000, status: 429, retryAfter: "60" },
        { latency: 100, status: 200 },
        { latency: 20_000, status: 503 },
        { latency: 100, status: 200 },
        { latency: 100, status: 200 },
        { latency: 100, status: 200 },
      ],
    },
  },
  {
    name: "a Retry-After that answers a send after another tab took over the batch still holds that tab's resend",
    covers: { lateWaits: 1, leaseHandoffs: 1 },
    thread: "Sol fourth final review of #265 at 57a8f5b0, finding 2",
    head: "57a8f5b0",
    seed: 2026112504,
    scenario: {
      profile: quiet,
      actions: [
        { at: 0, act: "open", tab: 1 },
        { at: 1000, act: "emit", tab: 1, count: 2 },
        { at: 6500, act: "hide", tab: 1 },
        { at: 7000, act: "show", tab: 1 },
        { at: 9000, act: "open", tab: 2 },
        { at: 10_000, act: "hide", tab: 1, throttled: true },
      ],
      replies: [
        { latency: 100, status: 503 },
        { latency: 30_000, status: 429, retryAfter: "60" },
        { latency: 100, status: 200 },
        { latency: 20_000, status: 503 },
        { latency: 100, status: 200 },
        { latency: 100, status: 200 },
      ],
    },
  },
  {
    name: "hiding the old owner as another tab reclaims its expired batch does not overwrite the new claim",
    covers: { races: 1, leaseHandoffs: 1 },
    thread: "Sol third final review of #265 at 6a6d20e2, finding 1",
    head: "6a6d20e2",
    seed: 2026112427,
    scenario: {
      profile: quiet,
      actions: [
        { at: 0, act: "open", tab: 1 },
        { at: 1000, act: "emit", tab: 1, count: 2 },
        { at: 6500, act: "hide", tab: 1 },
        { at: 7000, act: "show", tab: 1 },
        { at: 9000, act: "open", tab: 2 },
        { at: 9500, act: "open", tab: 3 },
        { at: 10_000, act: "hide", tab: 1, throttled: true },
        { at: 24_100, act: "hide", tab: 1, during: 2 },
      ],
      replies: [
        { latency: 100, status: 503 },
        { latency: 30_000, status: 503 },
        { latency: 100, status: 429, retryAfter: "60" },
        { latency: 100, status: 200 },
      ],
    },
  },
  {
    name: "a tab whose claim outlived its lease never saves over the newer claim's wait as it hides",
    covers: { leaseHandoffs: 1, retryAfters: 1 },
    thread: "https://github.com/ACM-VIT/conclave/pull/265#discussion_r4676724334",
    head: "8db1926b",
    seed: 4676724334,
    scenario: {
      profile: quiet,
      actions: [
        { at: 0, act: "open", tab: 1 },
        { at: 1000, act: "emit", tab: 1, count: 2 },
        { at: 6500, act: "hide", tab: 1 },
        { at: 7000, act: "show", tab: 1 },
        { at: 9000, act: "open", tab: 2 },
        { at: 10_000, act: "hide", tab: 1, throttled: true },
        { at: 25_000, act: "hide", tab: 1 },
      ],
      replies: [
        { latency: 100, status: 503 },
        { latency: 30_000, status: 503 },
        { latency: 100, status: 429, retryAfter: "60" },
        { latency: 100, status: 200 },
      ],
    },
  },
  {
    name: "a second and third lifecycle event right after the first do not beacon the batch again",
    covers: { beacons: 1, lifecycleDuringConfirmation: 2 },
    thread: "Sol final review of #265 at daf5493f, finding 2",
    head: "daf5493f",
    seed: 2026112402,
    scenario: {
      profile: { ...quiet, refuseRate: 1, beaconRefuseRate: 0 },
      actions: [
        { at: 0, act: "open", tab: 1 },
        { at: 1000, act: "emit", tab: 1, count: 2 },
        { at: 2000, act: "hide", tab: 1 },
        { at: 2100, act: "hide", tab: 1 },
        { at: 2200, act: "hide", tab: 1 },
        { at: 40_000, act: "show", tab: 1 },
      ],
      replies: [{ latency: 100, status: 200 }],
    },
  },
  {
    name: "a waiting batch beaconed as its tab hides, with storage refusing it, waits for its confirmation",
    covers: { beacons: 1, refusedWrites: 1 },
    thread: "https://github.com/ACM-VIT/conclave/pull/265#discussion_r4669367064",
    head: "223618b7",
    seed: 4669367064,
    scenario: {
      profile: { ...quiet, refuseRate: 1, beaconRefuseRate: 0 },
      actions: [
        { at: 0, act: "open", tab: 1 },
        { at: 1000, act: "emit", tab: 1, count: 2 },
        { at: 6500, act: "hide", tab: 1, throttled: true },
        { at: 8101, act: "hide", tab: 1 },
        { at: 10_000, act: "show", tab: 1 },
      ],
      replies: [
        { latency: 100, status: 503 },
        { latency: 100, status: 200 },
      ],
    },
  },
  {
    name: "a replay that outlives its request deadline is tried again while one tab stays open",
    covers: { savedAborts: 1, savedRetries: 1 },
    thread: "https://github.com/ACM-VIT/conclave/pull/265#discussion_r4667867771",
    head: "7800c707",
    seed: 4667867771,
    scenario: {
      profile: quiet,
      actions: [
        { at: 0, act: "open", tab: 1 },
        { at: 1000, act: "emit", tab: 1, count: 2 },
        { at: 2000, act: "hide", tab: 1 },
        { at: 3000, act: "show", tab: 1 },
      ],
      replies: [{ latency: 20_000, status: null }, { latency: 100, status: 200 }],
    },
  },
  {
    name: "a late Retry-After from an older send cannot shorten a newer one's wait",
    covers: { shorterLateWaits: 1, leaseHandoffs: 1 },
    thread: "https://github.com/ACM-VIT/conclave/pull/265#discussion_r4667407437",
    head: "893d216b",
    seed: 4667407437,
    scenario: {
      profile: quiet,
      actions: [
        { at: 0, act: "open", tab: 1 },
        { at: 1000, act: "emit", tab: 1, count: 2 },
        { at: 2000, act: "hide", tab: 1 },
        { at: 2500, act: "open", tab: 2 },
        { at: 3000, act: "hide", tab: 1, throttled: true },
        { at: 29_000, act: "show", tab: 1 },
      ],
      replies: [
        { latency: 25_000, status: 429, retryAfter: "1" },
        { latency: 100, status: 429, retryAfter: "60" },
        { latency: 100, status: 200 },
        { latency: 100, status: 200 },
      ],
    },
  },
  {
    name: "a batch storage refuses waits out its Retry-After in memory",
    covers: { refusedWrites: 1, retryAfters: 1 },
    thread: "https://github.com/ACM-VIT/conclave/pull/265#discussion_r4661287475",
    head: "67264378",
    seed: 4661287475,
    scenario: {
      profile: { ...quiet, refuseRate: 1 },
      actions: [
        { at: 0, act: "open", tab: 1 },
        { at: 1000, act: "emit", tab: 1, count: 2 },
        { at: 6500, act: "hide", tab: 1 },
      ],
      replies: [
        { latency: 100, status: 503, retryAfter: "5" },
        { latency: 100, status: 200 },
      ],
    },
  },
  {
    name: "replays go on with the backoff schedule instead of starting it again",
    covers: { retryAfters: 5, savedRetries: 4 },
    thread: "https://github.com/ACM-VIT/conclave/pull/265#discussion_r4661287478",
    head: "67264378",
    seed: 4661287478,
    scenario: {
      profile: quiet,
      actions: [
        { at: 0, act: "open", tab: 1 },
        { at: 1000, act: "emit", tab: 1, count: 2 },
        { at: 6500, act: "hide", tab: 1 },
        { at: 7000, act: "show", tab: 1 },
      ],
      replies: [
        { latency: 100, status: 429, retryAfter: "1" },
        { latency: 100, status: 429, retryAfter: "1" },
        { latency: 100, status: 429, retryAfter: "1" },
        { latency: 100, status: 429, retryAfter: "1" },
        { latency: 100, status: 429, retryAfter: "1" },
        { latency: 100, status: 200 },
      ],
    },
  },
];
