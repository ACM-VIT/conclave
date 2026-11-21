import { buildMeetingUrl } from "../../lib/meeting-links";

export function meetingLinkFor(
  roomId: string,
  clientId: string | null | undefined,
): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return buildMeetingUrl(origin, { roomCode: roomId, clientId });
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
