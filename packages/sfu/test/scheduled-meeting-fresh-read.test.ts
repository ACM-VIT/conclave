import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createScheduledMeeting,
  createScheduledMeetingPersistence,
  createScheduledMeetingStore,
  isScheduledMeetingInvitee,
  loadPersistedMeetings,
  persistScheduledMeetingChanges,
  refreshScheduledMeeting,
  setScheduledInviteeReadmission,
  type ScheduledMeetingPersistence,
} from "../server/scheduledMeetings.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const useStore = (mode: "sqlite" | "json") => {
  const dir = mkdtempSync(join(tmpdir(), "meetings-"));
  dirs.push(dir);
  vi.stubEnv("SCHEDULED_MEETINGS_PERSISTENCE", mode);
  vi.stubEnv("SCHEDULED_MEETINGS_SQLITE_PATH", join(dir, "conclave.sqlite"));
  vi.stubEnv("SCHEDULED_MEETINGS_PATH", join(dir, "scheduled-meetings.json"));
  vi.stubEnv("REDIS_URL", "");
  vi.stubEnv("SFU_REDIS_URL", "");
  vi.stubEnv("SFU_PERSISTENCE_REDIS_URL", "");
};

// One SFU: its own copy of the meetings in memory, over a store it may share.
const startSfu = async () => {
  const persistence = createScheduledMeetingPersistence();
  const meetings = createScheduledMeetingStore();
  await loadPersistedMeetings(meetings, persistence);
  return { persistence, meetings };
};
const isInvited = (sfu: Awaited<ReturnType<typeof startSfu>>) =>
  isScheduledMeetingInvitee(sfu.meetings, "conclave", "abc-mnop-xyz", "invitee@example.com");

describe.each(["sqlite", "json"] as const)(
  "two SFUs that share a %s schedule store",
  (mode) => {
    it("see an invitee's removal on the one that did not make it, once it reads fresh", async () => {
      useStore(mode);
      const sfuA = await startSfu();
      const meeting = createScheduledMeeting(
        sfuA.meetings,
        {
          title: "Intro call",
          scheduledStartAt: Date.now(),
          roomCode: "abc-mnop-xyz",
          hostEmail: "host@example.com",
          attendeeEmail: "invitee@example.com",
        },
        {
          clientId: "conclave",
          createdBy: "host@example.com",
          defaultHostEmail: "host@example.com",
          defaultHostUserId: null,
        },
      );
      await persistScheduledMeetingChanges(sfuA.meetings, sfuA.persistence, [meeting]);
      const sfuB = await startSfu();
      expect(isInvited(sfuB)).toBe(true);

      const removed = setScheduledInviteeReadmission(
        sfuA.meetings,
        "conclave",
        "abc-mnop-xyz",
        "invitee@example.com",
        true,
      );
      await persistScheduledMeetingChanges(sfuA.meetings, sfuA.persistence, [removed!]);
      expect(isInvited(sfuB)).toBe(true);

      await refreshScheduledMeeting(sfuB.meetings, sfuB.persistence, "conclave", "abc-mnop-xyz");
      expect(isInvited(sfuB)).toBe(false);
    });
  },
);

describe("reading a meeting fresh from the store", () => {
  const withMeeting = () => {
    const meetings = createScheduledMeetingStore();
    const meeting = createScheduledMeeting(
      meetings,
      {
        title: "Intro call",
        scheduledStartAt: Date.now(),
        roomCode: "abc-mnop-xyz",
        hostEmail: "host@example.com",
        attendeeEmail: "invitee@example.com",
      },
      {
        clientId: "conclave",
        createdBy: "host@example.com",
        defaultHostEmail: "host@example.com",
        defaultHostUserId: null,
      },
    );
    return { meetings, meeting };
  };
  const stored = (loadOne: ScheduledMeetingPersistence["loadOne"]) =>
    ({ save: () => {}, load: () => [], loadOne }) satisfies ScheduledMeetingPersistence;
  const invited = (meetings: ReturnType<typeof withMeeting>["meetings"]) =>
    isScheduledMeetingInvitee(meetings, "conclave", "abc-mnop-xyz", "invitee@example.com");

  it("keeps this SFU's copy when the store's is older", async () => {
    const { meetings, meeting } = withMeeting();
    const older = {
      ...meeting,
      readmissionRequiredEmails: ["invitee@example.com"],
      updatedAt: meeting.updatedAt - 1,
    };
    await refreshScheduledMeeting(meetings, stored(() => older), "conclave", "abc-mnop-xyz");
    expect(invited(meetings)).toBe(true);
  });

  it("keeps this SFU's copy when the store fails or cannot be read one meeting at a time", async () => {
    const { meetings } = withMeeting();
    await refreshScheduledMeeting(
      meetings,
      stored(() => {
        throw new Error("store down");
      }),
      "conclave",
      "abc-mnop-xyz",
    );
    await refreshScheduledMeeting(
      meetings,
      { save: () => {}, load: () => [] },
      "conclave",
      "abc-mnop-xyz",
    );
    expect(invited(meetings)).toBe(true);
  });

  it("does not keep a room waiting on a store that never answers", async () => {
    vi.useFakeTimers();
    const { meetings } = withMeeting();
    const refreshed = refreshScheduledMeeting(
      meetings,
      stored(() => new Promise(() => {})),
      "conclave",
      "abc-mnop-xyz",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(refreshed).resolves.toBeUndefined();
    expect(invited(meetings)).toBe(true);
  });
});
