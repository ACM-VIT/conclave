import type { MeetError } from "./types";

export const JOIN_REJECTED_MESSAGE = "The host has denied your request to join.";

export function joinRejectedUpdate() {
  const meetError: MeetError = {
    code: "JOIN_REJECTED",
    message: JOIN_REJECTED_MESSAGE,
    recoverable: false,
  };
  return {
    meetError,
    joinRejection: JOIN_REJECTED_MESSAGE,
    connectionState: "error" as const,
    waitingMessage: null,
  };
}

export type SetupNotice = { kind: "rejected" | "ended"; message: string };

export function setupNotice(
  joinRejection: string | null | undefined,
  meetingEndedNotice: string | null | undefined,
): SetupNotice | null {
  if (joinRejection) return { kind: "rejected", message: joinRejection };
  if (meetingEndedNotice) return { kind: "ended", message: meetingEndedNotice };
  return null;
}

const WAITING_FOR_HOST = /not live|not started|no room|not ready/i;

export interface HiddenSetupView {
  headline: string;
  body: string;
  action: "home" | "retry" | null;
  busy: boolean;
}

export function hiddenSetupView({
  joinRejection,
  meetingEndedNotice,
  errorMessage,
  isLoading,
}: {
  joinRejection: string | null | undefined;
  meetingEndedNotice: string | null | undefined;
  errorMessage: string;
  isLoading: boolean;
}): HiddenSetupView {
  const notice = setupNotice(joinRejection, meetingEndedNotice);
  if (notice?.kind === "rejected") {
    return { headline: "you weren't let in", body: notice.message, action: "retry", busy: false };
  }
  if (notice?.kind === "ended") {
    return { headline: "Webinar ended", body: notice.message, action: "home", busy: false };
  }
  const isWaitingForHost = WAITING_FOR_HOST.test(errorMessage);
  if (errorMessage && !isWaitingForHost) {
    return { headline: "we hit a snag", body: errorMessage, action: "retry", busy: false };
  }
  if (isWaitingForHost) {
    return {
      headline: "waiting for the host to start",
      body: "Hang tight. This page will refresh on its own the moment the host opens the room.",
      action: null,
      busy: false,
    };
  }
  return {
    headline: isLoading ? "getting you in" : "almost there",
    body: "Sit tight. Getting the room ready in a moment.",
    action: null,
    busy: true,
  };
}
