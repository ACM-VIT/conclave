import { sanitizeRoomCode, sanitizeRoomCodeInput } from "../app/lib/utils";
import { canonicalizeSfuClientId } from "./sfu-client-id";

type MeetingLinkInput = {
  roomCode: string;
  clientId?: string | null;
};

export const buildMeetingPath = (meeting: MeetingLinkInput): string => {
  const path = `/${encodeURIComponent(meeting.roomCode)}`;
  const clientId = canonicalizeSfuClientId(meeting.clientId);
  return clientId ? `${path}?clientId=${encodeURIComponent(clientId)}` : path;
};

export const buildMeetingUrl = (
  origin: string,
  meeting: MeetingLinkInput,
): string => `${origin.replace(/\/$/, "")}${buildMeetingPath(meeting)}`;

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const LOOKS_LIKE_HOST_PATH = /^[^\s/]+\.[^\s/]+\//;

export type MeetingInput = { roomCode: string; clientId: string | null };

export const parseMeetingInput = (raw: string): MeetingInput => {
  const trimmed = raw.trim();
  const typed = { roomCode: sanitizeRoomCodeInput(raw), clientId: null };
  if (!HAS_SCHEME.test(trimmed) && !LOOKS_LIKE_HOST_PATH.test(trimmed)) return typed;
  let url: URL;
  try {
    url = new URL(HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return typed;
  }
  const segment = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
  return {
    roomCode: sanitizeRoomCode(segment),
    clientId: url.searchParams.get("clientId")?.trim() || null,
  };
};

export type MeetingTarget = MeetingInput & { onThisPage: boolean };

export const meetingTarget = (
  roomCode: string,
  pasted: MeetingInput | null,
  pageClientId: string | null | undefined,
): MeetingTarget => {
  const page = canonicalizeSfuClientId(pageClientId);
  const linked = pasted?.roomCode === roomCode ? canonicalizeSfuClientId(pasted.clientId) : null;
  const clientId = linked ?? page;
  return { roomCode, clientId, onThisPage: clientId === page };
};
