import type { MeetError } from "./types";
import { mediaErrorAdvice } from "./utils";

export function describeEnterError(
  action: "new" | "join",
  error: MeetError,
  roomId = "",
): { title: string; detail: string; canRetry: boolean } {
  const verb = action === "new" ? "start" : "join";
  if (error.causes) {
    return {
      title: error.message,
      detail:
        mediaErrorAdvice(error) ??
        "Check your camera and microphone, then head back to setup to try again.",
      canRetry: false,
    };
  }
  switch (error.code) {
    case "ROOM_NOT_FOUND":
      return {
        title: "Check your meeting code",
        detail: `There's no meeting at ${roomId || "this code"} right now. Make sure the link or code is right.`,
        canRetry: false,
      };
    case "PERMISSION_DENIED":
      return {
        title: "Camera & mic are blocked",
        detail:
          "Allow access to your camera and microphone, then head back to setup to try again.",
        canRetry: false,
      };
    case "MEDIA_ERROR":
      return {
        title: "No camera or mic found",
        detail:
          "Check that your devices are connected, then head back to setup to try again.",
        canRetry: false,
      };
    case "CONNECTION_FAILED":
      return {
        title: `Couldn't ${verb} the meeting`,
        detail:
          "We couldn't reach the server. Check your connection and give it another go.",
        canRetry: true,
      };
    case "TRANSPORT_ERROR":
      return {
        title: `Couldn't ${verb} the meeting`,
        detail:
          "The media connection didn't go through. Another try usually does it.",
        canRetry: true,
      };
    case "UNKNOWN": {
      const raw = (error.message || "").trim();
      const technical =
        !raw ||
        /xhr|poll|websocket|transport|socket|network|fetch|timeout|load failed|econnrefused|err_/i.test(
          raw,
        );
      return {
        title: `Couldn't ${verb} the meeting`,
        detail: technical
          ? "Something interrupted the connection. Check your network and try again."
          : raw,
        canRetry: true,
      };
    }
  }
}
