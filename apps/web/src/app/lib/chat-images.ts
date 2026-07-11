import type { ChatImageAttachment } from "./types";

// Client-side mirror of the SFU's chat-image upload contract
// (MAX_CHAT_IMAGE_BYTES in packages/sfu/config/classes/Room.ts and the
// supported types in packages/sfu/server/chatImages.ts). The server
// re-validates everything; these exist so the picker can reject bad files
// before burning an upload round-trip.
export const MAX_CHAT_IMAGE_BYTES = 6 * 1024 * 1024;

export const CHAT_IMAGE_MIME_TYPES: readonly ChatImageAttachment["mimeType"][] =
  ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"];

export const CHAT_IMAGE_ACCEPT = CHAT_IMAGE_MIME_TYPES.join(",");

export const CHAT_IMAGE_TYPE_MESSAGE =
  "Choose a JPEG, PNG, GIF, WebP, or AVIF image.";
export const CHAT_IMAGE_SIZE_MESSAGE = "Images must be 6 MB or smaller.";
export const CHAT_IMAGE_MODERATION_BLOCKED_CODE =
  "chat_image_moderation_blocked";
export const CHAT_IMAGE_MODERATION_BLOCKED_MESSAGE =
  "Image not sent. Our safety check flagged it as potentially harmful. Only you can see this notice.";

type ClipboardImageData = {
  items: ArrayLike<
    Pick<DataTransferItem, "getAsFile" | "kind" | "type">
  >;
  files: ArrayLike<File>;
};

export function isSupportedChatImageType(mimeType: string): boolean {
  return (CHAT_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

export function findClipboardImageFile(
  clipboardData: ClipboardImageData,
): File | null {
  for (let index = 0; index < clipboardData.items.length; index += 1) {
    const item = clipboardData.items[index];
    if (item?.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return file;
  }

  for (let index = 0; index < clipboardData.files.length; index += 1) {
    const file = clipboardData.files[index];
    if (file?.type.startsWith("image/")) return file;
  }

  return null;
}

export function formatChatImageSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Image messages carry the file name as fallback content (so reply previews,
// TTS, and native clients always have text); only a sender-typed caption
// should render under the picture.
export function chatImageCaption(
  content: string,
  image: ChatImageAttachment,
): string | undefined {
  const trimmed = content.trim();
  return trimmed && trimmed !== image.fileName ? trimmed : undefined;
}
