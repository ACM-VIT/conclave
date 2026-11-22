"use client";

import { NotebookText } from "lucide-react";
import { useCallback, useState } from "react";
import InCallNotice from "./InCallNotice";
import InCallNoticeCard from "./InCallNoticeCard";

const MIN_MISSED_MS = 2 * 60 * 1000;

const dismissalKey = (sessionKey: string): string =>
  `conclave.catchup.dismissed.${sessionKey}`;

const readDismissed = (sessionKey: string): boolean => {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(dismissalKey(sessionKey)) === "1";
  } catch {
    return false;
  }
};

const writeDismissed = (sessionKey: string): void => {
  try {
    window.sessionStorage.setItem(dismissalKey(sessionKey), "1");
  } catch {
  }
};

interface CatchUpPillProps {
  startedAt: number | null;
  joinedAt: number | null;
  sessionKey: string;
  onOpen: () => void;
}

export default function CatchUpPill({
  startedAt,
  joinedAt,
  sessionKey,
  onOpen,
}: CatchUpPillProps) {
  const [dismissed, setDismissed] = useState(() => readDismissed(sessionKey));

  const dismiss = useCallback(() => {
    setDismissed(true);
    writeDismissed(sessionKey);
  }, [sessionKey]);

  const open = useCallback(() => {
    dismiss();
    onOpen();
  }, [dismiss, onOpen]);

  const missedMs =
    startedAt == null || joinedAt == null ? 0 : joinedAt - startedAt;
  const missedMinutes = Math.max(2, Math.round(missedMs / 60_000));

  return (
    <InCallNotice show={!dismissed && missedMs >= MIN_MISSED_MS}>
      <InCallNoticeCard
        icon={NotebookText}
        title={`You missed the first ${missedMinutes} minutes`}
        actionLabel="Catch up"
        onAction={open}
        onDismiss={dismiss}
        dismissLabel="Dismiss catch up"
      />
    </InCallNotice>
  );
}
