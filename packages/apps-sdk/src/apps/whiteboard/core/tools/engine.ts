import type { Point, WhiteboardElement } from "../model/types";
import { createId, addElement, updateElement, removeElement, getPageElements } from "../doc/index";
import { hitTestElement, translateElement } from "../model/geometry";
import type * as Y from "yjs";

export type ToolKind =
  | "select"
  | "pen"
  | "highlighter"
  | "eraser"
  | "rect"
  | "ellipse"
  | "line"
  | "text"
  | "sticky";

export type ToolSettings = {
  strokeColor: string;
  fillColor: string;
  strokeWidth: number;
  textColor: string;
  fontSize: number;
  stickyColor: string;
};

export type ToolState = {
  tool: ToolKind;
  settings: ToolSettings;
};

const distanceBetween = (a: Point, b: Point) =>
  Math.hypot(a.x - b.x, a.y - b.y);

const smoothStrokePoints = (points: Point[]): Point[] => {
  if (points.length <= 2) return points;

  const reduced: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const current = points[i];
    const previousKept = reduced[reduced.length - 1];
    if (distanceBetween(previousKept, current) < 0.8) {
      continue;
    }
    const next = points[i + 1];
    reduced.push({
      x: (previousKept.x + current.x + next.x) / 3,
      y: (previousKept.y + current.y + next.y) / 3,
      pressure: current.pressure,
    });
  }
  reduced.push(points[points.length - 1]);
  return reduced;
};

export class ToolEngine {
  private doc: Y.Doc;
  private pageId: string;
  private tool: ToolKind;
  private settings: ToolSettings;
  private activeElementId: string | null = null;
  private dragStart: Point | null = null;
  private lastPoint: Point | null = null;
  private selectedId: string | null = null;

  constructor(doc: Y.Doc, pageId: string, tool: ToolKind, settings: ToolSettings) {
    this.doc = doc;
    this.pageId = pageId;
    this.tool = tool;
    this.settings = settings;
  }

  setTool(tool: ToolKind) {
    if (this.tool !== tool) {
      this.activeElementId = null;
      this.dragStart = null;
      this.lastPoint = null;
      if (tool !== "select") {
        this.selectedId = null;
      }
    }
    this.tool = tool;
  }

  setSettings(settings: ToolSettings) {
    this.settings = settings;
  }

  setPage(pageId: string) {
    this.pageId = pageId;
    this.activeElementId = null;
    this.dragStart = null;
    this.lastPoint = null;
  }

  getSelectedId() {
    return this.selectedId;
  }

  clearSelection() {
    this.selectedId = null;
  }

  onPointerDown(point: Point) {
    this.dragStart = point;
    this.lastPoint = point;

    if (this.tool === "pen" || this.tool === "highlighter") {
      const id = createId();
      const element: WhiteboardElement = {
        id,
        type: "stroke",
        tool: this.tool,
        points: [point],
        color: this.settings.strokeColor,
        width: this.settings.strokeWidth,
        opacity: this.tool === "highlighter" ? 0.4 : 1,
      };
      addElement(this.doc, this.pageId, element);
      this.activeElementId = id;
      return;
    }

    if (this.tool === "rect" || this.tool === "ellipse" || this.tool === "line") {
      const id = createId();
      const element: WhiteboardElement = {
        id,
        type: "shape",
        shape: this.tool === "rect" ? "rect" : this.tool === "ellipse" ? "ellipse" : "line",
        x: point.x,
        y: point.y,
        width: 0,
        height: 0,
        strokeColor: this.settings.strokeColor,
        fillColor: this.settings.fillColor,
        strokeWidth: this.settings.strokeWidth,
      };
      addElement(this.doc, this.pageId, element);
      this.activeElementId = id;
      return;
    }

    if (this.tool === "text") {
      const id = createId();
      const element: WhiteboardElement = {
        id,
        type: "text",
        x: point.x,
        y: point.y,
        text: "",
        color: this.settings.textColor,
        fontSize: this.settings.fontSize,
      };
      addElement(this.doc, this.pageId, element);
      this.selectedId = id;
      return;
    }

    if (this.tool === "sticky") {
      const id = createId();
      const element: WhiteboardElement = {
        id,
        type: "sticky",
        x: point.x,
        y: point.y,
        width: 180,
        height: 140,
        text: "Sticky note",
        color: this.settings.stickyColor,
        textColor: "#111",
        fontSize: this.settings.fontSize,
      };
      addElement(this.doc, this.pageId, element);
      this.selectedId = id;
      return;
    }

    if (this.tool === "eraser") {
      this.eraseAtPoint(point);
      return;
    }

    if (this.tool === "select") {
      const elements = getPageElements(this.doc, this.pageId);
      const hit = [...elements].reverse().find((element) => hitTestElement(element, point));
      if (hit) {
        this.selectedId = hit.id;
      } else {
        this.selectedId = null;
      }
      return;
    }
  }

  onPointerMove(point: Point) {
    if (!this.dragStart || !this.lastPoint) return;

    if (this.tool === "pen" || this.tool === "highlighter") {
      if (!this.activeElementId) return;
      const elements = getPageElements(this.doc, this.pageId);
      const element = elements.find((item) => item.id === this.activeElementId);
      if (!element || element.type !== "stroke") return;
      if (this.lastPoint && this.lastPoint.x === point.x && this.lastPoint.y === point.y) {
        return;
      }
      const next = {
        ...element,
        points: [...element.points, point],
      };
      updateElement(this.doc, this.pageId, next);
      this.lastPoint = point;
      return;
    }

    if (this.tool === "rect" || this.tool === "ellipse" || this.tool === "line") {
      if (!this.activeElementId) return;
      const elements = getPageElements(this.doc, this.pageId);
      const element = elements.find((item) => item.id === this.activeElementId);
      if (!element || element.type !== "shape") return;
      const next = {
        ...element,
        x: this.dragStart.x,
        y: this.dragStart.y,
        width: point.x - this.dragStart.x,
        height: point.y - this.dragStart.y,
      };
      updateElement(this.doc, this.pageId, next);
      this.lastPoint = point;
      return;
    }

    if (this.tool === "eraser") {
      this.eraseAtPoint(point);
      return;
    }

    if (this.tool === "select" && this.selectedId && this.lastPoint) {
      const elements = getPageElements(this.doc, this.pageId);
      const element = elements.find((item) => item.id === this.selectedId);
      if (!element) return;
      const dx = point.x - this.lastPoint.x;
      const dy = point.y - this.lastPoint.y;
      if (dx === 0 && dy === 0) return;
      const next = translateElement(element, dx, dy);
      updateElement(this.doc, this.pageId, next);
      this.lastPoint = point;
      return;
    }
  }

  onPointerUp() {
    if (this.activeElementId && (this.tool === "pen" || this.tool === "highlighter")) {
      const elements = getPageElements(this.doc, this.pageId);
      const element = elements.find((item) => item.id === this.activeElementId);
      if (element && element.type === "stroke" && element.points.length > 2) {
        updateElement(this.doc, this.pageId, {
          ...element,
          points: smoothStrokePoints(element.points),
        });
      }
    }

    if (
      this.activeElementId &&
      (this.tool === "pen" ||
        this.tool === "highlighter" ||
        this.tool === "rect" ||
        this.tool === "ellipse" ||
        this.tool === "line")
    ) {
      this.selectedId = this.activeElementId;
    }
    this.dragStart = null;
    this.lastPoint = null;
    this.activeElementId = null;
  }

  private eraseAtPoint(point: Point) {
    const elements = getPageElements(this.doc, this.pageId);
    for (const element of elements) {
      if (hitTestElement(element, point, 12)) {
        removeElement(this.doc, this.pageId, element.id);
        break;
      }
    }
  }
}
