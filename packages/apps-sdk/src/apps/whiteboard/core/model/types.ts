export type Point = {
  x: number;
  y: number;
  pressure?: number;
};

export type StrokeElement = {
  id: string;
  type: "stroke";
  tool: "pen" | "highlighter";
  points: Point[];
  color: string;
  width: number;
  opacity?: number;
};

export type ShapeElement = {
  id: string;
  type: "shape";
  shape: "rect" | "ellipse" | "line";
  x: number;
  y: number;
  width: number;
  height: number;
  strokeColor: string;
  fillColor?: string;
  strokeWidth: number;
};

export type TextElement = {
  id: string;
  type: "text";
  x: number;
  y: number;
  text: string;
  color: string;
  fontSize: number;
  width?: number;
  height?: number;
};

export type StickyElement = {
  id: string;
  type: "sticky";
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color: string;
  textColor: string;
  fontSize: number;
};

export type ImageElement = {
  id: string;
  type: "image";
  x: number;
  y: number;
  width: number;
  height: number;
  src: string;
};

export type WhiteboardElement =
  | StrokeElement
  | ShapeElement
  | TextElement
  | StickyElement
  | ImageElement;

export type WhiteboardPage = {
  id: string;
  name: string;
  elements: WhiteboardElement[];
};

export type WhiteboardDocMeta = {
  activePageId: string;
};
