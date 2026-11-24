import type { Scenario } from "./outbox-sim";

export type ThreadCase = { name: string; thread: string; head: string; seed: number; scenario: Scenario };

const quiet = { refuseRate: 0, beaconRefuseRate: 1, beaconLossRate: 0, beaconLimitRate: 0, noLocks: false, maxTabs: 3 };

export const THREAD_CASES: ThreadCase[] = [
  {
    name: "a tab whose claim another tab replaced, without Web Locks, never saves over that newer claim's wait as it hides",
    thread: "https://github.com/ACM-VIT/conclave/pull/265#discussion_r4676724334",
    head: "8db1926b",
    seed: 4676724334,
    scenario: {
      profile: { ...quiet, noLocks: true },
      actions: [
        { at: 0, act: "open", tab: 1 },
        { at: 500, act: "open", tab: 2 },
        { at: 1000, act: "emit", tab: 1, count: 2 },
        { at: 6050, act: "hide", tab: 1 },
        { at: 8100, act: "race", tab: 1, other: 2 },
        { at: 9000, act: "hide", tab: 1 },
      ],
      replies: [
        { latency: 100, status: 503 },
        { latency: 10_000, status: 503 },
        { latency: 100, status: 429, retryAfter: "60" },
      ],
    },
  },
  {
    name: "a second and third lifecycle event right after the first do not beacon the batch again",
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
    thread: "https://github.com/ACM-VIT/conclave/pull/265#discussion_r4669367064",
    head: "223618b7",
    seed: 4669367064,
    scenario: {
      profile: { ...quiet, refuseRate: 1, beaconRefuseRate: 0 },
      actions: [
        { at: 0, act: "open", tab: 1 },
        { at: 1000, act: "emit", tab: 1, count: 2 },
        { at: 6500, act: "hide", tab: 1 },
        { at: 10_000, act: "show", tab: 1 },
      ],
      replies: [
        { latency: 100, status: 503 },
        { latency: 100, status: 200 },
      ],
    },
  },
  {
    name: "a replay slower than 10 s is tried again while one tab stays open",
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
      replies: [{ latency: 13_000, status: 200 }],
    },
  },
  {
    name: "a late Retry-After from an older send cannot shorten a newer one's wait",
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
        { at: 13_000, act: "show", tab: 1 },
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
    thread: "https://github.com/ACM-VIT/conclave/pull/265#discussion_r4661287475",
    head: "67264378",
    seed: 4661287475,
    scenario: {
      profile: { ...quiet, refuseRate: 1 },
      actions: [
        { at: 0, act: "open", tab: 1 },
        { at: 1000, act: "emit", tab: 1, count: 2 },
      ],
      replies: [
        { latency: 100, status: 503, retryAfter: "5" },
        { latency: 100, status: 200 },
      ],
    },
  },
  {
    name: "replays go on with the backoff schedule instead of starting it again",
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
