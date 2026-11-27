import {
  canonicalizeSfuClientId,
  CONCLAVE_SFU_CLIENT_ID,
  resolveSfuClientIdCandidates,
} from "./webSfuClientId.js";

export type StagingPublicScheduledMeeting = { id: string; clientId?: string; roomCode: string };

export const stagingPublicLookup =
  (base: string, secret: string) =>
  async (clientId: string, roomCode: string): Promise<StagingPublicScheduledMeeting | null> => {
    try {
      const resolvedClientId =
        canonicalizeSfuClientId(clientId) || CONCLAVE_SFU_CLIENT_ID;
      const url = `${base}/public/by-room/${encodeURIComponent(roomCode)}?clientId=${encodeURIComponent(resolvedClientId)}`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "x-sfu-secret": secret,
          accept: "application/json",
        },
        cache: "no-store",
      });
      if (!response.ok) return null;
      const data = (await response.json()) as {
        scheduledMeeting?: StagingPublicScheduledMeeting;
      };
      return data?.scheduledMeeting ?? null;
    } catch {
      return null;
    }
  };

export const stagingLookupScheduledMeetingCandidate = async (
  lookup: (clientId: string, roomCode: string) => Promise<StagingPublicScheduledMeeting | null>,
  roomCode: string,
  preferredClientId?: string,
): Promise<{ clientId: string; meeting: StagingPublicScheduledMeeting } | null> => {
  for (const clientId of resolveSfuClientIdCandidates(preferredClientId)) {
    const meeting = await lookup(clientId, roomCode);
    if (meeting) {
      return { clientId, meeting };
    }
  }
  return null;
};
