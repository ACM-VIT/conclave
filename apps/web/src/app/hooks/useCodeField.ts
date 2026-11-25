import { useState } from "react";
import { resolveCodeField } from "../lib/utils";

export function useCodeField(
  roomId: string,
  onRoomIdChange: (code: string) => void,
  conclaveOrigins: readonly string[],
) {
  const [text, setText] = useState(roomId);
  const [seenRoomId, setSeenRoomId] = useState(roomId);
  if (roomId !== seenRoomId) {
    setSeenRoomId(roomId);
    if (roomId !== resolveCodeField(text, conclaveOrigins).code) setText(roomId);
  }
  const change = (raw: string) => {
    setText(raw);
    onRoomIdChange(resolveCodeField(raw, conclaveOrigins).code);
  };
  return { text, resolution: resolveCodeField(text, conclaveOrigins), change };
}
