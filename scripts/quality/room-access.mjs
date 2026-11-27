export const JOINED_ROOM_STORAGE_KEY = "conclave:joined-room";

export const buildOpensRoomScript = (roomId) => `(() => {
  try {
    window.sessionStorage.setItem(
      ${JSON.stringify(JOINED_ROOM_STORAGE_KEY)},
      JSON.stringify({ roomId: ${JSON.stringify(roomId.toLowerCase())}, recoveryPass: null }),
    );
  } catch {}
})();`;

export const ADMIT_ONE_KNOCK_EXPRESSION = `(() => {
  const button = Array.from(document.querySelectorAll("button")).find((candidate) => {
    const label = candidate.getAttribute("aria-label") || "";
    return !candidate.disabled && label.startsWith("Admit ") && label !== "Admit all";
  });
  if (!button) return { ok: false };
  button.click();
  return { ok: true };
})()`;
