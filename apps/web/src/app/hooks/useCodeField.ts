import { useEffect, useState } from "react";
import { codeFieldTenant, resolveCodeField } from "../lib/utils";

export const CODE_FIELD_SETTLE_MS = 600;

const shownRoomId = (roomId: string) =>
  roomId === "undefined" || roomId === "null" ? "" : roomId;

export function useCodeField(
  roomId: string,
  onRoomIdChange: (code: string) => void,
  conclaveOrigins: readonly string[],
  pageClientId: string,
) {
  const [text, setText] = useState(() => shownRoomId(roomId));
  const [seenRoomId, setSeenRoomId] = useState(roomId);
  const [published, setPublished] = useState(roomId);
  const [settleNow, setSettleNow] = useState(false);
  if (roomId !== seenRoomId) {
    setSeenRoomId(roomId);
    if (roomId !== published) {
      setPublished(roomId);
      setText(shownRoomId(roomId));
    }
  }
  const resolution = resolveCodeField(text, conclaveOrigins);
  const tenant = codeFieldTenant(resolution, pageClientId);
  const lookup = tenant.onThisPage ? resolution.code : "";

  useEffect(() => {
    if (lookup === published) return;
    const timer = setTimeout(
      () => {
        setSettleNow(false);
        setPublished(lookup);
        onRoomIdChange(lookup);
      },
      lookup && !settleNow ? CODE_FIELD_SETTLE_MS : 0,
    );
    return () => clearTimeout(timer);
  }, [lookup, published, settleNow, onRoomIdChange]);

  const change = (raw: string) => {
    setText(raw);
    setSettleNow(false);
  };
  const settle = () => setSettleNow(true);
  return { text, resolution, tenant, settled: lookup === published, change, settle };
}
