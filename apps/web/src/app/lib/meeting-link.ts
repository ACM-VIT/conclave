import { buildMeetingUrl } from "../../lib/meeting-links";
import { resolveMeetingClientId } from "../../lib/sfu-client-id";

export function meetingLinkFor(
  roomId: string,
  clientId: string | null | undefined,
): string | null {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return buildMeetingUrl(origin, { roomCode: roomId, clientId: resolveMeetingClientId(clientId) });
}

export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
