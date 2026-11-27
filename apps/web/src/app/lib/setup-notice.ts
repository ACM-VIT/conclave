import type { MeetError } from "./types";

export type SetupNotice = { kind: "ended" | "rejected" | "removed"; message: string };

export const JOIN_REJECTED_MESSAGE = "The host has denied your request to join.";

export const endedNotice = (message: string): SetupNotice => ({ kind: "ended", message });

export const REMOVED_MESSAGE = "You were removed from this meeting.";

export const removedNotice = (): SetupNotice => ({ kind: "removed", message: REMOVED_MESSAGE });

export function joinRejectedUpdate() {
  const meetError: MeetError = {
    code: "JOIN_REJECTED",
    message: JOIN_REJECTED_MESSAGE,
    recoverable: false,
  };
  const setupNotice: SetupNotice = { kind: "rejected", message: JOIN_REJECTED_MESSAGE };
  return {
    meetError,
    setupNotice,
    connectionState: "error" as const,
    waitingMessage: null,
  };
}

const WAITING_FOR_HOST = /not live|not started|no room|not ready/i;

export interface HiddenSetupView {
  headline: string;
  body: string;
  action: "home" | "retry" | null;
  busy: boolean;
}

export function hiddenSetupView({
  notice,
  errorMessage,
  isLoading,
}: {
  notice: SetupNotice | null | undefined;
  errorMessage: string;
  isLoading: boolean;
}): HiddenSetupView {
  if (notice?.kind === "rejected") {
    return { headline: "You weren't let in", body: notice.message, action: "retry", busy: false };
  }
  if (notice?.kind === "removed") {
    return { headline: "You were removed", body: notice.message, action: "home", busy: false };
  }
  if (notice?.kind === "ended") {
    return { headline: "Webinar ended", body: notice.message, action: "home", busy: false };
  }
  const isWaitingForHost = WAITING_FOR_HOST.test(errorMessage);
  if (errorMessage && !isWaitingForHost) {
    return { headline: "We hit a snag", body: errorMessage, action: "retry", busy: false };
  }
  if (isWaitingForHost) {
    return {
      headline: "Waiting for the host to start",
      body: "Hang tight. This page will refresh on its own the moment the host opens the room.",
      action: null,
      busy: false,
    };
  }
  return {
    headline: isLoading ? "Getting you in" : "Almost there",
    body: "Sit tight. Getting the room ready in a moment.",
    action: null,
    busy: true,
  };
}
