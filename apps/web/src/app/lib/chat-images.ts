import type { ChatImageAttachment } from "./types";

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

const CHAT_IMAGE_EXTENSION_TYPES: Record<
  string,
  ChatImageAttachment["mimeType"]
> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
};

export function resolveChatImageType(
  file: Pick<File, "name" | "type">,
): ChatImageAttachment["mimeType"] | null {
  const type = file.type.trim().toLowerCase();
  if (type === "image/jpg" || type === "image/pjpeg") return "image/jpeg";
  if (isSupportedChatImageType(type)) {
    return type as ChatImageAttachment["mimeType"];
  }
  if (type && type !== "application/octet-stream") return null;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return CHAT_IMAGE_EXTENSION_TYPES[extension] ?? null;
}

function isClipboardImageCandidate(file: Pick<File, "name" | "type">) {
  return file.type.startsWith("image/") || resolveChatImageType(file) !== null;
}

export function findClipboardImageFile(
  clipboardData: ClipboardImageData,
): File | null {
  const candidates: File[] = [];

  for (let index = 0; index < clipboardData.items.length; index += 1) {
    const item = clipboardData.items[index];
    if (item?.kind !== "file") continue;
    if (item.type && !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file && isClipboardImageCandidate(file)) candidates.push(file);
  }

  for (let index = 0; index < clipboardData.files.length; index += 1) {
    const file = clipboardData.files[index];
    if (file && isClipboardImageCandidate(file)) candidates.push(file);
  }

  return (
    candidates.find((file) => resolveChatImageType(file) !== null) ??
    candidates[0] ??
    null
  );
}

function replaceFileExtension(name: string, extension: string): string {
  const base = name.replace(/\.[^./\\]+$/, "") || "image";
  return `${base}.${extension}`;
}

async function transcodeImageFile(
  file: File,
  maxBytes: number,
): Promise<File | null> {
  if (typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    const encode = (type: string, quality?: number) =>
      new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, type, quality),
      );
    const png = await encode("image/png");
    const pngFile = png
      ? new File([png], replaceFileExtension(file.name, "png"), {
          type: "image/png",
        })
      : null;
    if (pngFile && pngFile.size <= maxBytes) return pngFile;
    const jpeg = await encode("image/jpeg", 0.9);
    if (jpeg && jpeg.size <= maxBytes) {
      return new File([jpeg], replaceFileExtension(file.name, "jpg"), {
        type: "image/jpeg",
      });
    }
    return pngFile;
  } finally {
    bitmap.close();
  }
}

export async function prepareChatImageFile(file: File): Promise<File | null> {
  const resolvedType = resolveChatImageType(file);
  if (resolvedType) {
    return resolvedType === file.type
      ? file
      : new File([file], file.name || "image", { type: resolvedType });
  }
  if (!file.type.startsWith("image/")) return null;
  return transcodeImageFile(file, MAX_CHAT_IMAGE_BYTES);
}

export function formatChatImageSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function chatImageCaption(
  content: string,
  image: ChatImageAttachment,
): string | undefined {
  const trimmed = content.trim();
  return trimmed && trimmed !== image.fileName ? trimmed : undefined;
}
