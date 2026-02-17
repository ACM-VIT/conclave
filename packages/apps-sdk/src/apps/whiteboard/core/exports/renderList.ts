import type { WhiteboardElement } from "../model/types";

export type RenderCommand = WhiteboardElement & {
  opacity?: number;
};

export const buildRenderList = (elements: WhiteboardElement[]): RenderCommand[] => {
  return elements.map((element) => {
    if (element.type === "stroke" && element.tool === "highlighter") {
      return { ...element, opacity: element.opacity ?? 0.35 };
    }
    return { ...element };
  });
};
