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

export const parseMeetingInput = (raw: string): { roomCode: string; clientId: string | null } => {
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

export const crossTenantJoinPath = (
  roomCode: string,
  linkedClientId: string | null,
  currentClientId: string | null | undefined,
): string | null => {
  const linked = canonicalizeSfuClientId(linkedClientId);
  if (!linked || !roomCode || linked === canonicalizeSfuClientId(currentClientId)) return null;
  return buildMeetingPath({ roomCode, clientId: linked });
};
