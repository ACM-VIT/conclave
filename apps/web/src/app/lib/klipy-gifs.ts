import type { ChatGifAttachment, ChatGifAttachmentKind } from "./types";

export type KlipyMediaKind = "gifs" | "stickers" | "clips";

export const KLIPY_ATTACHMENT_KIND: Record<
  KlipyMediaKind,
  ChatGifAttachmentKind
> = {
  gifs: "gif",
  stickers: "sticker",
  clips: "clip",
};

export interface KlipyMediaResult extends ChatGifAttachment {
  previewUrl: string;
}

export interface KlipyMediaSearchResponse {
  items: KlipyMediaResult[];
  page: number;
  hasNext: boolean;
}

export const klipyMediaResultToAttachment = (
  item: KlipyMediaResult,
): ChatGifAttachment => ({
  id: item.id,
  title: item.title,
  url: item.url,
  previewUrl: item.previewUrl,
  ...(item.pageUrl ? { pageUrl: item.pageUrl } : {}),
  ...(item.width ? { width: item.width } : {}),
  ...(item.height ? { height: item.height } : {}),
  ...(item.kind ? { kind: item.kind } : {}),
  ...(item.videoUrl ? { videoUrl: item.videoUrl } : {}),
  source: "klipy",
});
