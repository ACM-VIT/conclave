import { useEffect, useState } from "react";
import type { RoomDestination } from "@/lib/meeting-links";
import { codeFieldTenant, resolveCodeField } from "../lib/utils";

export const CODE_FIELD_SETTLE_MS = 600;

const shownRoomId = (roomId: string) =>
  roomId === "undefined" || roomId === "null" ? "" : roomId;

export function useCodeField(
  roomId: string,
  conclaveOrigins: readonly string[],
  pageClientId: string,
  usesRoomCodes: boolean,
) {
  const [text, setText] = useState(() => shownRoomId(roomId));
  const [seenRoomId, setSeenRoomId] = useState(roomId);
  const [settleNow, setSettleNow] = useState(false);
  if (roomId !== seenRoomId) {
    setSeenRoomId(roomId);
    setText(shownRoomId(roomId));
    setSettleNow(false);
  }
  const resolution = !usesRoomCodes && text === shownRoomId(roomId)
    ? { code: text.trim(), clientId: null, tooLong: false }
    : resolveCodeField(text, conclaveOrigins);
  const tenant = codeFieldTenant(resolution, pageClientId);
  const destination: RoomDestination = { roomCode: resolution.code, clientId: tenant.clientId };
  const lookup = tenant.onThisPage ? destination.roomCode : "";
  const [settledLookup, setSettledLookup] = useState(lookup);

  useEffect(() => {
    if (lookup === settledLookup) return;
    const timer = setTimeout(
      () => setSettledLookup(lookup),
      lookup && !settleNow ? CODE_FIELD_SETTLE_MS : 0,
    );
    return () => clearTimeout(timer);
  }, [lookup, settledLookup, settleNow]);

  const change = (raw: string) => {
    setText(raw);
    setSettleNow(false);
  };
  const settle = () => setSettleNow(true);
  const settled = lookup === settledLookup;
  return { text, resolution, destination, onThisPage: tenant.onThisPage, lookup, settledLookup: settled ? lookup : "", settled, change, settle };
}
