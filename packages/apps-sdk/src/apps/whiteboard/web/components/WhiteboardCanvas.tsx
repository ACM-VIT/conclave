import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { buildRenderList } from "../../core/exports/renderList";
import type { ToolKind, ToolSettings } from "../../core/tools/engine";
import { ToolEngine } from "../../core/tools/engine";
import { getPageElements, removeElement, updateElement } from "../../core/doc/index";
import { useWhiteboardElements } from "../../shared/hooks/useWhiteboardElements";
import { renderCanvas } from "../renderer/renderCanvas";
import type { AppUser } from "../../../../sdk/types/index";
import { getColorForUser } from "../../core/presence/colors";
import type { StickyElement, TextElement, WhiteboardElement } from "../../core/model/types";
import { getBoundsForElement, hitTestElement, type Bounds } from "../../core/model/geometry";

export type WhiteboardCanvasProps = {
  doc: Y.Doc;
  awareness: Awareness;
  pageId: string;
  tool: ToolKind;
  settings: ToolSettings;
  locked: boolean;
  user?: AppUser;
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
  onToolChange?: (tool: ToolKind) => void;
  stressTestRequestId?: number | null;
  onStressTestComplete?: (result: WhiteboardStressResult) => void;
};

export type WhiteboardStressResult = {
  durationMs: number;
  strokeCount: number;
  frameCount: number;
  queuedMoveEvents: number;
};

const useResizeObserver = (ref: React.RefObject<HTMLDivElement | null>, onResize: () => void) => {
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(() => onResize());
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref, onResize]);
};

type EditableElement = TextElement | StickyElement;

const isEditableElement = (element: WhiteboardElement): element is EditableElement =>
  element.type === "text" || element.type === "sticky";

const FONT_STACK = 'Virgil, "Segoe Print", "Comic Sans MS", "Marker Felt", cursive';
const STICKY_TEXT_INSET = 8;
const RESIZE_HANDLE_HIT_RADIUS = 8;
const ROTATE_HANDLE_OFFSET = 26;
const ROTATE_HANDLE_HIT_RADIUS = 10;
const ROTATION_EPSILON = 0.0001;

const measureTextBounds = (text: string, fontSize: number) => {
  const lines = text.split("\n");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const fallbackLongest = lines.reduce(
    (max, line) => Math.max(max, line.length * fontSize * 0.62),
    0
  );
  const longestLineWidth = context
    ? (() => {
        context.font = `${fontSize}px ${FONT_STACK}`;
        return lines.reduce((max, line) => {
          const value = line.length > 0 ? line : " ";
          return Math.max(max, context.measureText(value).width);
        }, 0);
      })()
    : fallbackLongest;

  const lineHeight = fontSize * 1.25;
  return {
    width: Math.max(40, Math.ceil(longestLineWidth)),
    height: Math.max(Math.ceil(fontSize * 1.4), Math.ceil(lines.length * lineHeight)),
  };
};

const getStickyTextHeight = (element: StickyElement) => {
  const lines = element.text.split("\n");
  return Math.max(element.fontSize * 1.3, lines.length * element.fontSize * 1.3);
};

const getStickyViewportHeight = (element: StickyElement) => {
  return Math.max(0, element.height - STICKY_TEXT_INSET * 2);
};

const getMaxStickyScroll = (element: StickyElement) => {
  return Math.max(0, Math.ceil(getStickyTextHeight(element) - getStickyViewportHeight(element)));
};

type ResizeHandle = "nw" | "ne" | "sw" | "se";
type ResizableElement = Extract<
  WhiteboardElement,
  { type: "shape" | "sticky" | "image" | "text" | "stroke" }
>;
type RotatableElement = Extract<
  WhiteboardElement,
  { type: "shape" | "sticky" | "image" | "text" | "stroke" }
>;

type ResizeSession = {
  elementId: string;
  handle: ResizeHandle;
  startBounds: Bounds;
  startElement: ResizableElement;
};

type RotateSession = {
  elementId: string;
  center: { x: number; y: number };
  startPointerAngle: number;
  startRotation: number;
  startElement: RotatableElement;
};

const isResizableElement = (
  element: WhiteboardElement | null
): element is ResizableElement =>
  Boolean(
    element &&
      (element.type === "shape" ||
        element.type === "sticky" ||
        element.type === "image" ||
        element.type === "text" ||
        element.type === "stroke")
  );

const isRotatableElement = (
  element: WhiteboardElement | null
): element is RotatableElement =>
  Boolean(
    element &&
      (element.type === "shape" ||
        element.type === "sticky" ||
        element.type === "image" ||
        element.type === "text" ||
        element.type === "stroke")
  );

const normalizeRotation = (rotation: number) => Math.atan2(Math.sin(rotation), Math.cos(rotation));

const getElementRotation = (element: WhiteboardElement | null) => {
  if (!element || !("rotation" in element)) return 0;
  return element.rotation ?? 0;
};

const getRotatedBounds = (bounds: Bounds, rotation: number): Bounds => {
  if (Math.abs(rotation) < ROTATION_EPSILON) return bounds;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x, y: bounds.y + bounds.height },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
  ].map((corner) => {
    const dx = corner.x - centerX;
    const dy = corner.y - centerY;
    return {
      x: centerX + dx * Math.cos(rotation) - dy * Math.sin(rotation),
      y: centerY + dx * Math.sin(rotation) + dy * Math.cos(rotation),
    };
  });
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
};

const getSelectionBoundsForElement = (element: WhiteboardElement): Bounds => {
  const bounds = getBoundsForElement(element);
  if (!isRotatableElement(element)) return bounds;
  return getRotatedBounds(bounds, getElementRotation(element));
};

const getRotateHandlePoint = (bounds: Bounds) => ({
  x: bounds.x + bounds.width / 2,
  y: bounds.y - ROTATE_HANDLE_OFFSET,
});

const isPointOnRotateHandle = (bounds: Bounds, point: { x: number; y: number }) => {
  const handle = getRotateHandlePoint(bounds);
  return Math.hypot(point.x - handle.x, point.y - handle.y) <= ROTATE_HANDLE_HIT_RADIUS;
};

const getResizeHandleAtPoint = (
  bounds: Bounds,
  point: { x: number; y: number }
): ResizeHandle | null => {
  const corners: Array<{ handle: ResizeHandle; x: number; y: number }> = [
    { handle: "nw", x: bounds.x, y: bounds.y },
    { handle: "ne", x: bounds.x + bounds.width, y: bounds.y },
    { handle: "sw", x: bounds.x, y: bounds.y + bounds.height },
    { handle: "se", x: bounds.x + bounds.width, y: bounds.y + bounds.height },
  ];
  for (const corner of corners) {
    if (
      Math.abs(point.x - corner.x) <= RESIZE_HANDLE_HIT_RADIUS &&
      Math.abs(point.y - corner.y) <= RESIZE_HANDLE_HIT_RADIUS
    ) {
      return corner.handle;
    }
  }
  return null;
};

const getResizeMinimums = (element: ResizeSession["startElement"]) => {
  if (element.type === "text") {
    return { minWidth: 24, minHeight: Math.max(12, Math.round(element.fontSize * 0.8)) };
  }
  if (element.type === "stroke") {
    return { minWidth: 8, minHeight: 8 };
  }
  if (element.type === "sticky") {
    return { minWidth: 60, minHeight: 40 };
  }
  if (element.type === "image") {
    return { minWidth: 16, minHeight: 16 };
  }
  if (
    element.type === "shape" &&
    (element.shape === "line" || element.shape === "arrow")
  ) {
    return { minWidth: 8, minHeight: 8 };
  }
  return { minWidth: 12, minHeight: 12 };
};

const getResizedBounds = (
  startBounds: Bounds,
  handle: ResizeHandle,
  point: { x: number; y: number },
  minWidth: number,
  minHeight: number
): Bounds => {
  const left = startBounds.x;
  const top = startBounds.y;
  const right = startBounds.x + startBounds.width;
  const bottom = startBounds.y + startBounds.height;

  if (handle === "nw") {
    const x = Math.min(point.x, right - minWidth);
    const y = Math.min(point.y, bottom - minHeight);
    return { x, y, width: right - x, height: bottom - y };
  }

  if (handle === "ne") {
    const x = Math.max(point.x, left + minWidth);
    const y = Math.min(point.y, bottom - minHeight);
    return { x: left, y, width: x - left, height: bottom - y };
  }

  if (handle === "sw") {
    const x = Math.min(point.x, right - minWidth);
    const y = Math.max(point.y, top + minHeight);
    return { x, y: top, width: right - x, height: y - top };
  }

  const x = Math.max(point.x, left + minWidth);
  const y = Math.max(point.y, top + minHeight);
  return { x: left, y: top, width: x - left, height: y - top };
};

const applyResizedBounds = (
  element: ResizeSession["startElement"],
  startBounds: Bounds,
  bounds: Bounds
): ResizeSession["startElement"] => {
  if (element.type === "shape") {
    const widthDirection = element.width === 0 ? 1 : Math.sign(element.width);
    const heightDirection = element.height === 0 ? 1 : Math.sign(element.height);
    return {
      ...element,
      x: widthDirection >= 0 ? bounds.x : bounds.x + bounds.width,
      y: heightDirection >= 0 ? bounds.y : bounds.y + bounds.height,
      width: bounds.width * widthDirection,
      height: bounds.height * heightDirection,
    };
  }

  if (element.type === "text") {
    const widthScale = startBounds.width > 0 ? bounds.width / startBounds.width : 1;
    const heightScale = startBounds.height > 0 ? bounds.height / startBounds.height : 1;
    const fontScale = Math.max(0.2, (widthScale + heightScale) / 2);
    const nextFontSize = Math.max(8, Math.round(element.fontSize * fontScale));
    const measured = measureTextBounds(element.text.length > 0 ? element.text : " ", nextFontSize);
    return {
      ...element,
      x: bounds.x,
      y: bounds.y,
      fontSize: nextFontSize,
      width: measured.width,
      height: measured.height,
    };
  }

  if (element.type === "stroke") {
    const sourceWidth = startBounds.width;
    const sourceHeight = startBounds.height;
    return {
      ...element,
      points: element.points.map((point) => {
        const normalizedX =
          sourceWidth > 0 ? (point.x - startBounds.x) / sourceWidth : 0.5;
        const normalizedY =
          sourceHeight > 0 ? (point.y - startBounds.y) / sourceHeight : 0.5;
        return {
          ...point,
          x: bounds.x + normalizedX * bounds.width,
          y: bounds.y + normalizedY * bounds.height,
        };
      }),
    };
  }

  return {
    ...element,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
};

export function WhiteboardCanvas({
  doc,
  awareness,
  pageId,
  tool,
  settings,
  locked,
  user,
  canvasRef,
  onToolChange,
  stressTestRequestId,
  onStressTestComplete,
}: WhiteboardCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const internalCanvasRef = useRef<HTMLCanvasElement>(null);
  const resolvedCanvasRef = canvasRef ?? internalCanvasRef;
  const engineRef = useRef<ToolEngine | null>(null);
  const cursorRafRef = useRef<number | null>(null);
  const moveRafRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<{ x: number; y: number; pressure?: number } | null>(null);
  const renderFrameRef = useRef<number | null>(null);
  const renderQueuedRef = useRef(false);
  const drawRef = useRef<() => void>(() => {});
  const stressRunningRef = useRef(false);
  const lastStressRequestRef = useRef<number | null>(null);
  const canvasMetricsRef = useRef<{ pixelWidth: number; pixelHeight: number; scale: number } | null>(
    null
  );
  const elements = useWhiteboardElements(doc, pageId);
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const latestCursorRef = useRef<{ x: number; y: number } | null>(null);
  const resizeSessionRef = useRef<ResizeSession | null>(null);
  const rotateSessionRef = useRef<RotateSession | null>(null);
  const textEditorRef = useRef<HTMLTextAreaElement>(null);
  const [imageVersion, setImageVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingElementId, setEditingElementId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [stickyScrollOffsets, setStickyScrollOffsets] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!engineRef.current) {
      engineRef.current = new ToolEngine(doc, pageId, tool, settings);
    }
    engineRef.current.setPage(pageId);
    engineRef.current.setTool(tool);
    engineRef.current.setSettings(settings);
  }, [doc, pageId, tool, settings]);

  useEffect(() => {
    if (!selectedId) return;
    if (!elements.some((element) => element.id === selectedId)) {
      setSelectedId(null);
    }
  }, [elements, selectedId]);

  useEffect(() => {
    if (!editingElementId) return;
    if (!elements.some((element) => element.id === editingElementId && isEditableElement(element))) {
      setEditingElementId(null);
      setEditingText("");
    }
  }, [elements, editingElementId]);

  useEffect(() => {
    setStickyScrollOffsets((prev) => {
      const next: Record<string, number> = {};
      for (const element of elements) {
        if (element.type !== "sticky") continue;
        const offset = prev[element.id] ?? 0;
        const maxScroll = getMaxStickyScroll(element);
        const clamped = Math.min(Math.max(offset, 0), maxScroll);
        if (clamped > 0) {
          next[element.id] = clamped;
        }
      }
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(next);
      if (
        prevKeys.length === nextKeys.length &&
        prevKeys.every((key) => prev[key] === next[key])
      ) {
        return prev;
      }
      return next;
    });
  }, [elements]);

  useEffect(() => {
    const state = awareness.getLocalState() ?? {};
    awareness.setLocalState({
      ...state,
      user: {
        id: user?.id ?? "guest",
        name: user?.name ?? "Guest",
        color: getColorForUser(user?.id ?? "guest"),
      },
    });
  }, [awareness, user]);

  useEffect(() => {
    const imageSources = new Set<string>();
    let cancelled = false;

    for (const element of elements) {
      if (element.type !== "image") continue;
      imageSources.add(element.src);
      if (imageCacheRef.current.has(element.src)) continue;

      const image = new Image();
      image.onload = () => {
        if (cancelled) return;
        imageCacheRef.current.set(element.src, image);
        setImageVersion((value) => value + 1);
      };
      image.onerror = () => {
        if (cancelled) return;
        imageCacheRef.current.delete(element.src);
      };
      image.src = element.src;
    }

    for (const src of Array.from(imageCacheRef.current.keys())) {
      if (!imageSources.has(src)) {
        imageCacheRef.current.delete(src);
      }
    }

    return () => {
      cancelled = true;
    };
  }, [elements]);

  const scheduleCursorSync = useCallback(
    (x: number, y: number) => {
      latestCursorRef.current = { x, y };
      if (cursorRafRef.current !== null) return;
      cursorRafRef.current = requestAnimationFrame(() => {
        cursorRafRef.current = null;
        const cursor = latestCursorRef.current;
        if (!cursor) return;
        awareness.setLocalStateField("cursor", cursor);
      });
    },
    [awareness]
  );

  const clearCursor = useCallback(() => {
    if (cursorRafRef.current !== null) {
      cancelAnimationFrame(cursorRafRef.current);
      cursorRafRef.current = null;
    }
    latestCursorRef.current = null;
    awareness.setLocalStateField("cursor", null);
  }, [awareness]);

  useEffect(() => {
    return () => {
      if (moveRafRef.current !== null) {
        cancelAnimationFrame(moveRafRef.current);
        moveRafRef.current = null;
      }
      pendingMoveRef.current = null;
      if (renderFrameRef.current !== null) {
        cancelAnimationFrame(renderFrameRef.current);
        renderFrameRef.current = null;
      }
      renderQueuedRef.current = false;
      clearCursor();
    };
  }, [clearCursor]);

  const startEditingById = useCallback(
    (elementId: string | null) => {
      if (locked || !elementId) return;
      // Read fresh elements from doc — the element may have just been created
      const freshElements = getPageElements(doc, pageId);
      const element = freshElements.find(
        (item): item is EditableElement =>
          item.id === elementId && isEditableElement(item)
      );
      if (!element) return;
      setSelectedId(element.id);
      setEditingElementId(element.id);
      setEditingText(element.text);
    },
    [doc, locked, pageId]
  );

  const commitEditing = useCallback(() => {
    if (!editingElementId) return;
    const element = getPageElements(doc, pageId).find(
      (item): item is EditableElement =>
        item.id === editingElementId && isEditableElement(item)
    );
    const text = editingText.replace(/\r\n/g, "\n");
    if (element) {
      if (element.type === "text") {
        if (text.trim().length === 0) {
          removeElement(doc, pageId, element.id);
          if (selectedId === element.id) {
            setSelectedId(null);
          }
        } else {
          const bounds = measureTextBounds(text, element.fontSize);
          updateElement(doc, pageId, {
            ...element,
            text,
            width: bounds.width,
            height: bounds.height,
          });
        }
      } else {
        updateElement(doc, pageId, { ...element, text });
      }
    }
    setEditingElementId(null);
    setEditingText("");
  }, [doc, editingElementId, editingText, pageId, selectedId]);

  // Live-update the element text while editing for real-time collaboration sync
  useEffect(() => {
    if (!editingElementId) return;
    const element = getPageElements(doc, pageId).find(
      (item): item is EditableElement =>
        item.id === editingElementId && isEditableElement(item)
    );
    if (!element) return;
    const text = editingText.replace(/\r\n/g, "\n");
    if (element.type === "text") {
      const bounds = measureTextBounds(text.length > 0 ? text : " ", element.fontSize);
      updateElement(doc, pageId, {
        ...element,
        text,
        width: bounds.width,
        height: bounds.height,
      });
    } else {
      updateElement(doc, pageId, { ...element, text });
    }
  }, [editingText, editingElementId, doc, pageId]);

  useEffect(() => {
    if (!editingElementId) return;
    const editor = textEditorRef.current;
    if (!editor) return;
    editor.focus();
    const end = editor.value.length;
    editor.setSelectionRange(end, end);
  }, [editingElementId]);

  // Enter key on selected text/sticky element → enter editing mode
  // Delete/Backspace on selected element → delete it
  useEffect(() => {
    if (locked || editingElementId) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (target?.isContentEditable || tag === "input" || tag === "textarea" || tag === "select") {
        return;
      }

      if (event.key === "Enter" && selectedId && tool === "select") {
        const element = elements.find(
          (item): item is EditableElement =>
            item.id === selectedId && isEditableElement(item)
        );
        if (element) {
          event.preventDefault();
          startEditingById(element.id);
        }
      }

      if ((event.key === "Delete" || event.key === "Backspace") && selectedId && tool === "select") {
        event.preventDefault();
        removeElement(doc, pageId, selectedId);
        setSelectedId(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [locked, editingElementId, selectedId, tool, elements, startEditingById, doc, pageId]);

  const flushPendingMove = useCallback(() => {
    const point = pendingMoveRef.current;
    pendingMoveRef.current = null;
    moveRafRef.current = null;
    if (!point || locked) return;
    engineRef.current?.onPointerMove(point);
  }, [locked]);

  const queuePointerMove = useCallback(
    (point: { x: number; y: number; pressure?: number }) => {
      pendingMoveRef.current = point;
      if (moveRafRef.current !== null) return;
      moveRafRef.current = requestAnimationFrame(flushPendingMove);
    },
    [flushPendingMove]
  );

  const drawCanvas = useCallback(() => {
    const canvas = resolvedCanvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const rect = container.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(rect.width * scale));
    const pixelHeight = Math.max(1, Math.round(rect.height * scale));
    const previousMetrics = canvasMetricsRef.current;
    if (
      !previousMetrics ||
      previousMetrics.pixelWidth !== pixelWidth ||
      previousMetrics.pixelHeight !== pixelHeight ||
      previousMetrics.scale !== scale
    ) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      canvasMetricsRef.current = { pixelWidth, pixelHeight, scale };
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    // Keep sticky background visible while editing by only hiding sticky text.
    // For plain text elements, hide the element entirely under the editor.
    const renderedElements = editingElementId
      ? elements.flatMap((element) => {
          if (element.id !== editingElementId) return [element];
          if (element.type === "sticky") {
            return [{ ...element, text: "" }];
          }
          return [];
        })
      : elements;
    const renderList = buildRenderList(renderedElements).map((element) => {
      if (element.type !== "sticky") return element;
      const maxScroll = getMaxStickyScroll(element);
      const offset = stickyScrollOffsets[element.id] ?? 0;
      const clamped = Math.min(Math.max(offset, 0), maxScroll);
      if (clamped === 0) return element;
      return { ...element, stickyScrollOffset: clamped };
    });
    renderCanvas(ctx, renderList, rect.width, rect.height, imageCacheRef.current);
  }, [elements, editingElementId, imageVersion, stickyScrollOffsets]);

  useEffect(() => {
    drawRef.current = drawCanvas;
  }, [drawCanvas]);

  const flushScheduledRender = useCallback(() => {
    renderFrameRef.current = null;
    if (!renderQueuedRef.current) return;
    renderQueuedRef.current = false;
    drawRef.current();
  }, []);

  const scheduleRender = useCallback(() => {
    renderQueuedRef.current = true;
    if (renderFrameRef.current !== null) return;
    renderFrameRef.current = requestAnimationFrame(flushScheduledRender);
  }, [flushScheduledRender]);

  useResizeObserver(containerRef, scheduleRender);

  useEffect(() => {
    scheduleRender();
  }, [scheduleRender, drawCanvas]);

  const runStressTest = useCallback(async () => {
    if (stressRunningRef.current || locked) return;
    const engine = engineRef.current;
    const container = containerRef.current;
    if (!engine || !container) return;

    stressRunningRef.current = true;
    const previousTool = tool;
    const strokeCount = 8;
    const framesPerStroke = 16;
    const movesPerFrame = 14;
    let queuedMoveEvents = 0;
    const startTime = performance.now();

    try {
      engine.setTool("pen");
      const rect = container.getBoundingClientRect();
      const centerX = rect.width * 0.5;
      const centerY = rect.height * 0.5;
      const radius = Math.max(24, Math.min(rect.width, rect.height) * 0.22);

      for (let strokeIndex = 0; strokeIndex < strokeCount; strokeIndex += 1) {
        const startAngle = (Math.PI * 2 * strokeIndex) / strokeCount;
        const startPoint = {
          x: centerX + Math.cos(startAngle) * radius,
          y: centerY + Math.sin(startAngle) * radius,
          pressure: 0.6,
        };
        engine.onPointerDown(startPoint);
        scheduleCursorSync(startPoint.x, startPoint.y);

        for (let frame = 0; frame < framesPerStroke; frame += 1) {
          for (let burst = 0; burst < movesPerFrame; burst += 1) {
            const moveIndex = frame * movesPerFrame + burst + 1;
            const t = moveIndex / (framesPerStroke * movesPerFrame);
            const angle = startAngle + t * Math.PI * 3.6;
            const wobble = Math.sin((strokeIndex + 1) * t * Math.PI * 4) * 12;
            const point = {
              x: centerX + Math.cos(angle) * (radius + wobble),
              y: centerY + Math.sin(angle) * (radius - wobble * 0.4),
              pressure: 0.25 + ((moveIndex + strokeIndex) % 5) * 0.15,
            };
            queuePointerMove(point);
            queuedMoveEvents += 1;
          }

          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        }

        flushPendingMove();
        engine.onPointerUp();
      }

      engine.setTool(previousTool);
      setSelectedId(engine.getSelectedId() ?? null);
      clearCursor();
      scheduleRender();

      onStressTestComplete?.({
        durationMs: performance.now() - startTime,
        strokeCount,
        frameCount: strokeCount * framesPerStroke,
        queuedMoveEvents,
      });
    } finally {
      engine.setTool(previousTool);
      stressRunningRef.current = false;
    }
  }, [
    clearCursor,
    flushPendingMove,
    locked,
    onStressTestComplete,
    queuePointerMove,
    scheduleCursorSync,
    scheduleRender,
    tool,
  ]);

  useEffect(() => {
    if (stressTestRequestId == null) return;
    if (stressTestRequestId === lastStressRequestRef.current) return;
    lastStressRequestRef.current = stressTestRequestId;
    void runStressTest();
  }, [runStressTest, stressTestRequestId]);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (editingElementId) {
        commitEditing();
      }
      const rect = event.currentTarget.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top, pressure: event.pressure };
      event.currentTarget.setPointerCapture(event.pointerId);
      pendingMoveRef.current = null;
      if (moveRafRef.current !== null) {
        cancelAnimationFrame(moveRafRef.current);
        moveRafRef.current = null;
      }
      if (!locked) {
        if (tool === "select" && selectedId) {
          const selectedElement = elements.find((element) => element.id === selectedId) ?? null;
          if (selectedElement) {
            const selectedBounds = getSelectionBoundsForElement(selectedElement);
            if (isRotatableElement(selectedElement) && isPointOnRotateHandle(selectedBounds, point)) {
              const center = {
                x: selectedBounds.x + selectedBounds.width / 2,
                y: selectedBounds.y + selectedBounds.height / 2,
              };
              event.preventDefault();
              rotateSessionRef.current = {
                elementId: selectedElement.id,
                center,
                startPointerAngle: Math.atan2(point.y - center.y, point.x - center.x),
                startRotation: getElementRotation(selectedElement),
                startElement: selectedElement,
              };
              scheduleCursorSync(point.x, point.y);
              return;
            }

            const canResize = isResizableElement(selectedElement);
            if (canResize) {
              const handle = getResizeHandleAtPoint(selectedBounds, point);
              if (handle) {
                event.preventDefault();
                resizeSessionRef.current = {
                  elementId: selectedElement.id,
                  handle,
                  startBounds: selectedBounds,
                  startElement: selectedElement,
                };
                scheduleCursorSync(point.x, point.y);
                return;
              }
            }
          }
        }

        engineRef.current?.onPointerDown(point);
        const nextSelectedId = engineRef.current?.getSelectedId() ?? null;
        setSelectedId(nextSelectedId);
        if (tool === "text" || tool === "sticky") {
          // Use setTimeout so the Yjs element is flushed before we try to read it
          setTimeout(() => startEditingById(nextSelectedId), 0);
          // Auto-switch back to select tool after placing text
          if (onToolChange) {
            setTimeout(() => onToolChange("select"), 10);
          }
        }
      }
      scheduleCursorSync(point.x, point.y);
    },
    [
      commitEditing,
      editingElementId,
      elements,
      locked,
      onToolChange,
      scheduleCursorSync,
      selectedId,
      startEditingById,
      tool,
    ]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top, pressure: event.pressure };
      if (!locked && event.buttons) {
        const rotateSession = rotateSessionRef.current;
        if (rotateSession) {
          event.preventDefault();
          const pointerAngle = Math.atan2(
            point.y - rotateSession.center.y,
            point.x - rotateSession.center.x
          );
          const delta = pointerAngle - rotateSession.startPointerAngle;
          const unsnappedRotation = normalizeRotation(rotateSession.startRotation + delta);
          const snapStep = Math.PI / 12;
          const nextRotation = event.shiftKey
            ? Math.round(unsnappedRotation / snapStep) * snapStep
            : unsnappedRotation;
          updateElement(doc, pageId, {
            ...rotateSession.startElement,
            rotation: normalizeRotation(nextRotation),
          });
          setSelectedId(rotateSession.elementId);
          scheduleCursorSync(point.x, point.y);
          return;
        }
        const resizeSession = resizeSessionRef.current;
        if (resizeSession) {
          event.preventDefault();
          const { minWidth, minHeight } = getResizeMinimums(resizeSession.startElement);
          const nextBounds = getResizedBounds(
            resizeSession.startBounds,
            resizeSession.handle,
            point,
            minWidth,
            minHeight
          );
          const nextElement = applyResizedBounds(
            resizeSession.startElement,
            resizeSession.startBounds,
            nextBounds
          );
          updateElement(doc, pageId, nextElement);
          setSelectedId(resizeSession.elementId);
          scheduleCursorSync(point.x, point.y);
          return;
        }
        queuePointerMove(point);
      }
      scheduleCursorSync(point.x, point.y);
    },
    [doc, locked, pageId, queuePointerMove, scheduleCursorSync]
  );

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const rotateSession = rotateSessionRef.current;
    if (rotateSession) {
      rotateSessionRef.current = null;
      setSelectedId(rotateSession.elementId);
      clearCursor();
      return;
    }
    const resizeSession = resizeSessionRef.current;
    if (resizeSession) {
      resizeSessionRef.current = null;
      setSelectedId(resizeSession.elementId);
      clearCursor();
      return;
    }
    if (!locked) {
      flushPendingMove();
      engineRef.current?.onPointerUp();
      setSelectedId(engineRef.current?.getSelectedId() ?? null);
    }
    clearCursor();
  }, [locked, clearCursor, flushPendingMove]);

  const handlePointerLeave = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      handlePointerUp(event);
    },
    [handlePointerUp]
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLCanvasElement>) => {
      if (editingElementId) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const sticky = [...elements]
        .reverse()
        .find(
          (element): element is StickyElement =>
            element.type === "sticky" && hitTestElement(element, point, 0)
        );
      if (!sticky) return;
      const maxScroll = getMaxStickyScroll(sticky);
      if (maxScroll <= 0) return;

      event.preventDefault();
      event.stopPropagation();
      setStickyScrollOffsets((prev) => {
        const current = prev[sticky.id] ?? 0;
        const next = Math.min(Math.max(current + event.deltaY, 0), maxScroll);
        if (Math.abs(next - current) < 0.5) return prev;
        return { ...prev, [sticky.id]: next };
      });
    },
    [editingElementId, elements]
  );

  const handleDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      if (locked) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const point = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
      // Double-click on any text/sticky element starts editing (from any tool)
      const hit = [...elements]
        .reverse()
        .find((element) => isEditableElement(element) && hitTestElement(element, point));
      if (hit && isEditableElement(hit)) {
        startEditingById(hit.id);
        // Switch to select tool so selection UI works
        if (tool !== "select" && onToolChange) {
          onToolChange("select");
        }
      } else if (tool === "select") {
        // Double-click on empty space creates a new text element
        const id = engineRef.current ? (() => {
          engineRef.current.setTool("text");
          engineRef.current.onPointerDown(point);
          const newId = engineRef.current.getSelectedId();
          engineRef.current.setTool("select");
          return newId;
        })() : null;
        if (id) {
          setSelectedId(id);
          setTimeout(() => startEditingById(id), 0);
        }
      }
    },
    [elements, locked, onToolChange, startEditingById, tool]
  );

  const selectedElement = useMemo(
    () => elements.find((element) => element.id === selectedId) ?? null,
    [elements, selectedId]
  );

  const editingElement = useMemo(() => {
    if (!editingElementId) return null;
    const element = elements.find((item) => item.id === editingElementId);
    if (!element || !isEditableElement(element)) return null;
    return element;
  }, [editingElementId, elements]);

  const editingTextBounds = useMemo(() => {
    if (!editingElement || editingElement.type !== "text") return null;
    return measureTextBounds(
      editingText.length > 0 ? editingText : " ",
      editingElement.fontSize
    );
  }, [editingElement, editingText]);

  const editorStyle = useMemo<CSSProperties | null>(() => {
    if (!editingElement) return null;
    if (editingElement.type === "text") {
      return {
        position: "absolute",
        left: editingElement.x,
        top: editingElement.y,
        minWidth: 1,
        width: Math.max(1, (editingTextBounds?.width ?? 40) + 4),
        minHeight: Math.max(editingElement.fontSize * 1.4, 24),
        height: Math.max(
          editingElement.fontSize * 1.4,
          (editingTextBounds?.height ?? editingElement.fontSize * 1.4) + 2
        ),
        color: editingElement.color,
        fontSize: editingElement.fontSize,
        fontFamily: FONT_STACK,
        lineHeight: "1.3",
        border: "none",
        borderRadius: 0,
        backgroundColor: "transparent",
        padding: 0,
        margin: 0,
        resize: "none",
        overflow: "hidden",
        outline: "none",
        boxShadow: "none",
        zIndex: 100,
        caretColor: editingElement.color,
        whiteSpace: "pre",
        wordBreak: "keep-all",
      };
    }

    return {
      position: "absolute",
      left: editingElement.x + 8,
      top: editingElement.y + 8,
      width: Math.max(60, editingElement.width - 16),
      height: Math.max(40, editingElement.height - 16),
      color: editingElement.textColor,
      fontSize: editingElement.fontSize,
      fontFamily: FONT_STACK,
      lineHeight: "1.25",
      border: "none",
      borderRadius: 6,
      backgroundColor: "transparent",
      padding: 0,
      resize: "none",
      outline: "none",
      zIndex: 100,
      caretColor: editingElement.textColor,
      overflowY: "auto",
      overflowX: "hidden",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
    };
  }, [editingElement, editingTextBounds]);

  const selectionBounds = useMemo(
    () => (selectedElement ? getSelectionBoundsForElement(selectedElement) : null),
    [selectedElement]
  );
  const selectedRotation = useMemo(
    () => getElementRotation(selectedElement),
    [selectedElement]
  );
  const canResizeSelectedElement = useMemo(
    () => isResizableElement(selectedElement),
    [selectedElement]
  );
  const canRotateSelectedElement = useMemo(
    () => isRotatableElement(selectedElement),
    [selectedElement]
  );
  const rotateHandleOffsetTop = 4 - ROTATE_HANDLE_OFFSET;
  const rotateHandleCenterX = selectionBounds
    ? (Math.max(1, selectionBounds.width) + 8) / 2
    : 0;
  const rotateHandleConnectorTop = rotateHandleOffsetTop + 6;
  const rotateHandleConnectorHeight = Math.max(8, -rotateHandleConnectorTop);
  const rotateHandleCenterY = rotateHandleOffsetTop;
  const rotateHandleVisible = Boolean(selectionBounds && canRotateSelectedElement);
  const rotationDegrees = (selectedRotation * 180) / Math.PI;
  const rotationLabel = `${Math.round(rotationDegrees)}deg`;

  return (
    <div ref={containerRef} className="w-full h-full relative">
      <canvas
        ref={resolvedCanvasRef}
        className="w-full h-full touch-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onWheel={handleWheel}
        onDoubleClick={handleDoubleClick}
      />
      {selectionBounds && tool === "select" && !editingElement ? (
        <div
          className="absolute pointer-events-none"
          style={{
            left: selectionBounds.x - 4,
            top: selectionBounds.y - 4,
            width: Math.max(1, selectionBounds.width) + 8,
            height: Math.max(1, selectionBounds.height) + 8,
            border: "1.5px solid #6965db",
            borderRadius: 4,
          }}
        >
          {canResizeSelectedElement
            ? [
                { left: -4, top: -4 },
                { right: -4, top: -4 },
                { left: -4, bottom: -4 },
                { right: -4, bottom: -4 },
              ].map((position, index) => (
                <div
                  key={index}
                  className="absolute"
                  style={{
                    ...position,
                    width: 7,
                    height: 7,
                    borderRadius: 1,
                    backgroundColor: "#fff",
                    border: "1.5px solid #6965db",
                  }}
                />
              ))
            : null}
          {rotateHandleVisible ? (
            <>
              <div
                className="absolute"
                style={{
                  left: rotateHandleCenterX - 1,
                  top: rotateHandleConnectorTop,
                  width: 2,
                  height: rotateHandleConnectorHeight,
                  backgroundColor: "#6965db",
                }}
              />
              <div
                className="absolute"
                style={{
                  left: rotateHandleCenterX - 6,
                  top: rotateHandleCenterY - 6,
                  width: 12,
                  height: 12,
                  borderRadius: 999,
                  backgroundColor: "#fff",
                  border: "1.5px solid #6965db",
                }}
                title={`Rotation: ${rotationLabel}`}
              />
            </>
          ) : null}
        </div>
      ) : null}
      {editingElement && editorStyle ? (
        <>
          {/* Subtle dashed outline around editing element */}
          {(() => {
            const b = getBoundsForElement(editingElement);
            return (
              <div
                className="absolute pointer-events-none"
                style={{
                  left: b.x - 4,
                  top: b.y - 4,
                  width: Math.max(1, b.width) + 8,
                  height: Math.max(1, Math.max(b.height, editingElement.fontSize * 1.4)) + 8,
                  border: "1px dashed rgba(105, 101, 219, 0.5)",
                  borderRadius: 4,
                  zIndex: 99,
                }}
              />
            );
          })()}
          <textarea
            ref={textEditorRef}
            value={editingText}
            onChange={(event) => setEditingText(event.target.value)}
            onWheel={(event) => event.stopPropagation()}
            onBlur={() => commitEditing()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                commitEditing();
                return;
              }
              if (
                editingElement.type === "text" &&
                event.key === "Enter" &&
                !event.shiftKey
              ) {
                event.preventDefault();
                commitEditing();
              }
              if (
                editingElement.type === "sticky" &&
                event.key === "Enter" &&
                (event.metaKey || event.ctrlKey)
              ) {
                event.preventDefault();
                commitEditing();
              }
            }}
            spellCheck={false}
            style={editorStyle}
          />
        </>
      ) : null}
    </div>
  );
}
