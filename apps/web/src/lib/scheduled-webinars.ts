export type ScheduledWebinarStatus =
  | "scheduled"
  | "live"
  | "ended"
  | "cancelled";

export interface ScheduledWebinarCoHost {
  email: string;
  name?: string;
}

export interface ScheduledWebinar {
  id: string;
  clientId: string;
  roomId: string;
  linkSlug: string;
  title: string;
  description: string;
  hostEmail: string;
  hostName: string;
  hostUserId: string | null;
  coHosts: ScheduledWebinarCoHost[];
  scheduledStartAt: number;
  scheduledEndAt: number;
  status: ScheduledWebinarStatus;
  publicAccess: boolean;
  maxAttendees: number;
  requiresInviteCode: boolean;
  waitingRoomEnabled: boolean;
  earlyEntryMinutes: number;
  qaEnabled: boolean;
  recordingRequested: boolean;
  notes: string;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  liveStartedAt: number | null;
  endedAt: number | null;
  totalJoinCount: number;
  peakAttendeeCount: number;
  webinarLink: string;
}

export interface CreateScheduledWebinarPayload {
  title: string;
  description?: string;
  scheduledStartAt: number;
  scheduledEndAt?: number;
  hostEmail?: string;
  hostName?: string;
  coHosts?: ScheduledWebinarCoHost[];
  linkSlug?: string;
  publicAccess?: boolean;
  maxAttendees?: number;
  inviteCode?: string | null;
  waitingRoomEnabled?: boolean;
  earlyEntryMinutes?: number;
  qaEnabled?: boolean;
  recordingRequested?: boolean;
  notes?: string;
}

export interface UpdateScheduledWebinarPayload
  extends Partial<CreateScheduledWebinarPayload> {
  status?: ScheduledWebinarStatus;
}

export const isWebinarLive = (
  webinar: Pick<ScheduledWebinar, "status">,
): boolean => webinar.status === "live";

export const isWebinarOpen = (
  webinar: Pick<
    ScheduledWebinar,
    "status" | "scheduledStartAt" | "earlyEntryMinutes"
  >,
  now = Date.now(),
): boolean => {
  if (webinar.status === "ended" || webinar.status === "cancelled") return false;
  const earlyMs = webinar.earlyEntryMinutes * 60 * 1000;
  return now >= webinar.scheduledStartAt - earlyMs;
};
