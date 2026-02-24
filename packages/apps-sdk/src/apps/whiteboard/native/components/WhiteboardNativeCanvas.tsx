import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PanResponder,
  StyleSheet,
  View,
  Pressable,
  Text as RNText,
  TextInput,
  Image,
  type LayoutChangeEvent,
  type GestureResponderEvent,
} from "react-native";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { Canvas, Path, Rect, Oval, Line, Skia, Group } from "@shopify/react-native-skia";
import { Check, X } from "lucide-react-native";
import { buildRenderList } from "../../core/exports/renderList";
import type { ToolKind, ToolSettings } from "../../core/tools/engine";
import { ToolEngine } from "../../core/tools/engine";
import { updateElement } from "../../core/doc/index";
import { useWhiteboardElements } from "../../shared/hooks/useWhiteboardElements";
import type { AppUser } from "../../../../sdk/types/index";
import { getColorForUser } from "../../core/presence/colors";
import type { StickyElement, TextElement, WhiteboardElement } from "../../core/model/types";
import type { PresenceState } from "../../../../sdk/hooks/useAppPresence";
import { getBoundsForElement, hitTestElement, type Bounds } from "../../core/model/geometry";

type EditableElement = TextElement | StickyElement;

const isEditableElement = (element: WhiteboardElement): element is EditableElement =>
  element.type === "text" || element.type === "sticky";

const DEFAULT_SCENE_BOUNDS = {
  x: -160,
  y: -120,
  width: 1280,
  height: 880,
};

const EXTRA_SCENE_PADDING = 120;
const WHITEBOARD_FONT_FAMILY = "Virgil";
const HANDLE_HIT_RADIUS = 12;

type ResizeHandle = "nw" | "ne" | "sw" | "se";
type ResizableElement = Extract<WhiteboardElement, { type: "shape" | "sticky" | "image" }>;

type ResizeSession = {
  elementId: string;
  handle: ResizeHandle;
  startBounds: Bounds;
  startElement: ResizableElement;
};

const isResizableElement = (
  element: WhiteboardElement | null
): element is ResizableElement =>
  Boolean(
    element &&
      (element.type === "shape" || element.type === "sticky" || element.type === "image")
  );

const getResizeHandleAtPoint = (
  bounds: Bounds,
  touch: { x: number; y: number },
  viewport: { x: number; y: number; scale: number }
): ResizeHandle | null => {
  const corners: Array<{ handle: ResizeHandle; x: number; y: number }> = [
    { handle: "nw", x: bounds.x, y: bounds.y },
    { handle: "ne", x: bounds.x + bounds.width, y: bounds.y },
    { handle: "sw", x: bounds.x, y: bounds.y + bounds.height },
    { handle: "se", x: bounds.x + bounds.width, y: bounds.y + bounds.height },
  ];
  for (const corner of corners) {
    const screenX = corner.x * viewport.scale + viewport.x;
    const screenY = corner.y * viewport.scale + viewport.y;
    if (
      Math.abs(touch.x - screenX) <= HANDLE_HIT_RADIUS &&
      Math.abs(touch.y - screenY) <= HANDLE_HIT_RADIUS
    ) {
      return corner.handle;
    }
  }
  return null;
};

const getResizeMinimums = (element: ResizableElement) => {
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
  element: ResizableElement,
  bounds: Bounds
): ResizableElement => {
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

  return {
    ...element,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
};

export type WhiteboardNativeCanvasProps = {
  doc: Y.Doc;
  awareness: Awareness;
  pageId: string;
  tool: ToolKind;
  settings: ToolSettings;
  locked: boolean;
  user?: AppUser;
  states?: PresenceState[];
  onRequestTextEdit?: (elementId: string, currentText: string) => void;
  editingText?: { elementId: string; text: string } | null;
  onEditingTextChange?: (text: string) => void;
  onEditingTextSubmit?: () => void;
  onEditingTextBlur?: () => void;
  onEditingTextCancel?: () => void;
};

const seedFrom = (value: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const createRng = (seed: number) => {
  let state = seed || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
};

const jitterOffset = (id: string, pass: number, amount: number) => {
  const rng = createRng(seedFrom(id) + pass * 1699);
  return {
    x: (rng() * 2 - 1) * amount,
    y: (rng() * 2 - 1) * amount,
  };
};

const buildPath = (
  points: { x: number; y: number }[],
  offsetX = 0,
  offsetY = 0,
) => {
  const path = Skia.Path.Make();
  if (points.length === 0) return path;
  path.moveTo(points[0].x + offsetX, points[0].y + offsetY);
  for (let i = 1; i < points.length; i += 1) {
    path.lineTo(points[i].x + offsetX, points[i].y + offsetY);
  }
  return path;
};

const renderElement = (element: WhiteboardElement) => {
  switch (element.type) {
    case "stroke": {
      const rough = jitterOffset(element.id, 1, Math.max(0.8, element.width * 0.25));
      return (
        <React.Fragment key={element.id}>
          <Path
            path={buildPath(element.points)}
            style="stroke"
            strokeWidth={element.width}
            color={element.color}
            opacity={element.opacity ?? 1}
            strokeJoin="round"
            strokeCap="round"
          />
          <Path
            path={buildPath(element.points, rough.x, rough.y)}
            style="stroke"
            strokeWidth={Math.max(1, element.width * 0.85)}
            color={element.color}
            opacity={(element.opacity ?? 1) * 0.58}
            strokeJoin="round"
            strokeCap="round"
          />
        </React.Fragment>
      );
    }
    case "shape": {
      const rough = jitterOffset(element.id, 2, Math.max(0.9, element.strokeWidth * 0.5));
      if (element.shape === "rect") {
        const x = Math.min(element.x, element.x + element.width);
        const y = Math.min(element.y, element.y + element.height);
        const width = Math.abs(element.width);
        const height = Math.abs(element.height);
        return (
          <React.Fragment key={element.id}>
            {element.fillColor ? (
              <Rect
                x={x}
                y={y}
                width={width}
                height={height}
                style="fill"
                color={element.fillColor}
                opacity={0.28}
              />
            ) : null}
            <Rect
              x={x}
              y={y}
              width={width}
              height={height}
              style="stroke"
              color={element.strokeColor}
              strokeWidth={element.strokeWidth}
            />
            <Rect
              x={x + rough.x}
              y={y + rough.y}
              width={width}
              height={height}
              style="stroke"
              color={element.strokeColor}
              opacity={0.62}
              strokeWidth={Math.max(1, element.strokeWidth * 0.85)}
            />
          </React.Fragment>
        );
      }

      if (element.shape === "ellipse") {
        const x = Math.min(element.x, element.x + element.width);
        const y = Math.min(element.y, element.y + element.height);
        const width = Math.abs(element.width);
        const height = Math.abs(element.height);
        return (
          <React.Fragment key={element.id}>
            {element.fillColor ? (
              <Oval
                x={x}
                y={y}
                width={width}
                height={height}
                style="fill"
                color={element.fillColor}
                opacity={0.28}
              />
            ) : null}
            <Oval
              x={x}
              y={y}
              width={width}
              height={height}
              style="stroke"
              color={element.strokeColor}
              strokeWidth={element.strokeWidth}
            />
            <Oval
              x={x + rough.x}
              y={y + rough.y}
              width={width}
              height={height}
              style="stroke"
              color={element.strokeColor}
              opacity={0.62}
              strokeWidth={Math.max(1, element.strokeWidth * 0.85)}
            />
          </React.Fragment>
        );
      }

      if (element.shape === "line") {
        return (
          <React.Fragment key={element.id}>
            <Line
              p1={{ x: element.x, y: element.y }}
              p2={{ x: element.x + element.width, y: element.y + element.height }}
              color={element.strokeColor}
              strokeWidth={element.strokeWidth}
            />
            <Line
              p1={{ x: element.x + rough.x, y: element.y + rough.y }}
              p2={{
                x: element.x + element.width + rough.x,
                y: element.y + element.height + rough.y,
              }}
              color={element.strokeColor}
              opacity={0.62}
              strokeWidth={Math.max(1, element.strokeWidth * 0.85)}
            />
          </React.Fragment>
        );
      }

      if (element.shape === "arrow") {
        const start = { x: element.x, y: element.y };
        const end = { x: element.x + element.width, y: element.y + element.height };
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.hypot(dx, dy);
        const angle = Math.atan2(dy, dx);
        const targetHeadLength = Math.min(38, Math.max(12, element.strokeWidth * 3.6));
        const headLength = Math.min(length * 0.45, targetHeadLength);
        const spread = Math.PI / 5.8;
        const left = {
          x: end.x - headLength * Math.cos(angle - spread),
          y: end.y - headLength * Math.sin(angle - spread),
        };
        const right = {
          x: end.x - headLength * Math.cos(angle + spread),
          y: end.y - headLength * Math.sin(angle + spread),
        };
        const roughStart = { x: start.x + rough.x, y: start.y + rough.y };
        const roughEnd = { x: end.x + rough.x, y: end.y + rough.y };
        const roughLeft = { x: left.x + rough.x, y: left.y + rough.y };
        const roughRight = { x: right.x + rough.x, y: right.y + rough.y };

        return (
          <React.Fragment key={element.id}>
            <Line
              p1={start}
              p2={end}
              color={element.strokeColor}
              strokeWidth={element.strokeWidth}
            />
            {length > 0 ? (
              <>
                <Line
                  p1={end}
                  p2={left}
                  color={element.strokeColor}
                  strokeWidth={element.strokeWidth}
                />
                <Line
                  p1={end}
                  p2={right}
                  color={element.strokeColor}
                  strokeWidth={element.strokeWidth}
                />
              </>
            ) : null}

            <Line
              p1={roughStart}
              p2={roughEnd}
              color={element.strokeColor}
              opacity={0.62}
              strokeWidth={Math.max(1, element.strokeWidth * 0.85)}
            />
            {length > 0 ? (
              <>
                <Line
                  p1={roughEnd}
                  p2={roughLeft}
                  color={element.strokeColor}
                  opacity={0.62}
                  strokeWidth={Math.max(1, element.strokeWidth * 0.85)}
                />
                <Line
                  p1={roughEnd}
                  p2={roughRight}
                  color={element.strokeColor}
                  opacity={0.62}
                  strokeWidth={Math.max(1, element.strokeWidth * 0.85)}
                />
              </>
            ) : null}
          </React.Fragment>
        );
      }

      return null;
    }
    default:
      return null;
  }
};

const getSceneBounds = (elements: WhiteboardElement[]) => {
  if (elements.length === 0) return null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const element of elements) {
    const bounds = getBoundsForElement(element);
    const width = Math.max(1, bounds.width);
    const height = Math.max(1, bounds.height);
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + width);
    maxY = Math.max(maxY, bounds.y + height);
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null;
  }

  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
};

export function WhiteboardNativeCanvas({
  doc,
  awareness,
  pageId,
  tool,
  settings,
  locked,
  user,
  states = [],
  onRequestTextEdit,
  editingText,
  onEditingTextChange,
  onEditingTextSubmit,
  onEditingTextBlur,
  onEditingTextCancel,
}: WhiteboardNativeCanvasProps) {
  const engineRef = useRef<ToolEngine | null>(null);
  const cursorRafRef = useRef<number | null>(null);
  const moveRafRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<{ x: number; y: number; pressure?: number } | null>(null);
  const suppressNextBlurCommitRef = useRef(false);
  const latestCursorRef = useRef<{ x: number; y: number } | null>(null);
  const resizeSessionRef = useRef<ResizeSession | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [hasUserViewportTransform, setHasUserViewportTransform] = useState(false);
  const [autoFitSignature, setAutoFitSignature] = useState<string | null>(null);
  const elements = useWhiteboardElements(doc, pageId);
  const renderList = useMemo(() => buildRenderList(elements), [elements]);

  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const pinchRef = useRef<{
    active: boolean;
    initialDistance: number;
    initialScale: number;
    initialMidX: number;
    initialMidY: number;
    initialOffsetX: number;
    initialOffsetY: number;
  } | null>(null);

  const MIN_SCALE = 0.25;
  const MAX_SCALE = 5;

  /** Convert a screen-space point to canvas-space */
  const toCanvas = useCallback(
    (sx: number, sy: number) => ({
      x: (sx - viewport.x) / viewport.scale,
      y: (sy - viewport.y) / viewport.scale,
    }),
    [viewport],
  );

  useEffect(() => {
    if (!engineRef.current) {
      engineRef.current = new ToolEngine(doc, pageId, tool, settings);
    }
    engineRef.current.setPage(pageId);
    engineRef.current.setTool(tool);
    engineRef.current.setSettings(settings);
  }, [doc, pageId, tool, settings]);

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
    if (!selectedId) return;
    if (!elements.some((element) => element.id === selectedId)) {
      setSelectedId(null);
    }
  }, [elements, selectedId]);

  const editingElement = useMemo(() => {
    if (!editingText?.elementId) return null;
    const element = elements.find((item) => item.id === editingText.elementId);
    if (!element || !isEditableElement(element)) return null;
    return element;
  }, [editingText?.elementId, elements]);

  const sceneBounds = useMemo(() => getSceneBounds(elements), [elements]);

  const submitEditing = useCallback(() => {
    suppressNextBlurCommitRef.current = true;
    onEditingTextSubmit?.();
  }, [onEditingTextSubmit]);

  const cancelEditing = useCallback(() => {
    suppressNextBlurCommitRef.current = true;
    onEditingTextCancel?.();
  }, [onEditingTextCancel]);

  const handleEditorBlur = useCallback(() => {
    if (suppressNextBlurCommitRef.current) {
      suppressNextBlurCommitRef.current = false;
      return;
    }
    onEditingTextBlur?.();
  }, [onEditingTextBlur]);

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
    [flushPendingMove],
  );

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
    [awareness],
  );

  const clearCursor = useCallback(() => {
    latestCursorRef.current = null;
    awareness.setLocalStateField("cursor", null);
  }, [awareness]);

  useEffect(() => {
    return () => {
      if (cursorRafRef.current !== null) {
        cancelAnimationFrame(cursorRafRef.current);
      }
      if (moveRafRef.current !== null) {
        cancelAnimationFrame(moveRafRef.current);
      }
      pendingMoveRef.current = null;
      clearCursor();
    };
  }, [clearCursor]);

  useEffect(() => {
    resizeSessionRef.current = null;
    setHasUserViewportTransform(false);
    setAutoFitSignature(null);
  }, [pageId]);

  useEffect(() => {
    if (canvasSize.width <= 0 || canvasSize.height <= 0) return;
    if (hasUserViewportTransform) return;

    const sceneSignature =
      elements.length > 0
        ? `${pageId}:scene:${canvasSize.width}x${canvasSize.height}`
        : `${pageId}:empty:${canvasSize.width}x${canvasSize.height}`;

    if (sceneSignature === autoFitSignature) return;

    const bounds = sceneBounds ?? DEFAULT_SCENE_BOUNDS;
    const inset = Math.max(
      24,
      Math.min(56, Math.round(Math.min(canvasSize.width, canvasSize.height) * 0.08)),
    );
    const contentWidth = Math.max(320, bounds.width + EXTRA_SCENE_PADDING);
    const contentHeight = Math.max(220, bounds.height + EXTRA_SCENE_PADDING);
    const fitScale = Math.min(
      (canvasSize.width - inset * 2) / contentWidth,
      (canvasSize.height - inset * 2) / contentHeight,
    );
    const scale = Math.max(MIN_SCALE, Math.min(1, fitScale));
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;

    setViewport({
      x: canvasSize.width / 2 - centerX * scale,
      y: canvasSize.height / 2 - centerY * scale,
      scale,
    });
    setAutoFitSignature(sceneSignature);
  }, [
    autoFitSignature,
    canvasSize.height,
    canvasSize.width,
    elements.length,
    hasUserViewportTransform,
    pageId,
    sceneBounds,
    MIN_SCALE,
  ]);

  const getTouches = (event: GestureResponderEvent) => {
    const touches = event.nativeEvent.touches;
    if (!touches || touches.length === 0) {
      return [{ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }];
    }
    return Array.from(touches).map((t: any) => ({
      x: t.locationX ?? t.pageX,
      y: t.locationY ?? t.pageY,
    }));
  };

  const getDistance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(b.x - a.x, b.y - a.y);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          const touches = getTouches(event);
          const { force } = event.nativeEvent;

          if (touches.length >= 2) {
            resizeSessionRef.current = null;
            flushPendingMove();
            const dist = getDistance(touches[0], touches[1]);
            const midX = (touches[0].x + touches[1].x) / 2;
            const midY = (touches[0].y + touches[1].y) / 2;
            pinchRef.current = {
              active: true,
              initialDistance: dist,
              initialScale: viewport.scale,
              initialMidX: midX,
              initialMidY: midY,
              initialOffsetX: viewport.x,
              initialOffsetY: viewport.y,
            };
            setHasUserViewportTransform(true);
          } else {
            const pt = toCanvas(touches[0].x, touches[0].y);

            if (!locked && tool === "select" && selectedId) {
              const selectedElement =
                elements.find((element) => element.id === selectedId) ?? null;
              if (isResizableElement(selectedElement)) {
                const selectedBounds = getBoundsForElement(selectedElement);
                const handle = getResizeHandleAtPoint(
                  selectedBounds,
                  touches[0],
                  viewport,
                );
                if (handle) {
                  resizeSessionRef.current = {
                    elementId: selectedElement.id,
                    handle,
                    startBounds: selectedBounds,
                    startElement: selectedElement,
                  };
                  scheduleCursorSync(pt.x, pt.y);
                  pinchRef.current = null;
                  return;
                }
              }
            }

            // In text tools, tapping an existing text/sticky should edit it instead of creating a new element.
            if (!locked && onRequestTextEdit && (tool === "text" || tool === "sticky")) {
              const editableHit = [...elements]
                .reverse()
                .find(
                  (item): item is EditableElement =>
                    isEditableElement(item) && hitTestElement(item, pt, 10),
                );
              if (editableHit) {
                setSelectedId(editableHit.id);
                onRequestTextEdit(editableHit.id, editableHit.text);
                scheduleCursorSync(pt.x, pt.y);
                pinchRef.current = null;
                return;
              }
            }

            if (!locked) {
              engineRef.current?.onPointerDown({ x: pt.x, y: pt.y, pressure: force });
              const newSelectedId = engineRef.current?.getSelectedId() ?? null;
              setSelectedId(newSelectedId);

              // Text/sticky tools should immediately edit the newly placed element.
              if (
                newSelectedId &&
                onRequestTextEdit &&
                (tool === "text" || tool === "sticky")
              ) {
                const created = elements.find((item) => item.id === newSelectedId);
                onRequestTextEdit(
                  newSelectedId,
                  created && isEditableElement(created)
                    ? created.text
                    : tool === "sticky"
                      ? "Sticky note"
                      : "",
                );
              }
            }
            scheduleCursorSync(pt.x, pt.y);
            pinchRef.current = null;
          }
        },
        onPanResponderMove: (event) => {
          const touches = getTouches(event);
          const { force } = event.nativeEvent;

          if (touches.length >= 2) {
            resizeSessionRef.current = null;
            const dist = getDistance(touches[0], touches[1]);
            const midX = (touches[0].x + touches[1].x) / 2;
            const midY = (touches[0].y + touches[1].y) / 2;

            if (!pinchRef.current) {
              if (!locked) {
                flushPendingMove();
                engineRef.current?.onPointerUp();
              }
              pinchRef.current = {
                active: true,
                initialDistance: dist,
                initialScale: viewport.scale,
                initialMidX: midX,
                initialMidY: midY,
                initialOffsetX: viewport.x,
                initialOffsetY: viewport.y,
              };
              setHasUserViewportTransform(true);
              return;
            }

            const pinch = pinchRef.current;
            const rawScale = (dist / pinch.initialDistance) * pinch.initialScale;
            const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, rawScale));

            const scaleRatio = newScale / pinch.initialScale;
            const newX =
              midX - (pinch.initialMidX - pinch.initialOffsetX) * scaleRatio +
              (midX - pinch.initialMidX);
            const newY =
              midY - (pinch.initialMidY - pinch.initialOffsetY) * scaleRatio +
              (midY - pinch.initialMidY);

            setViewport({ x: newX, y: newY, scale: newScale });
            setHasUserViewportTransform(true);
          } else if (!pinchRef.current) {
            // Single finger draw
            const pt = toCanvas(touches[0].x, touches[0].y);
            const resizeSession = resizeSessionRef.current;
            if (!locked && resizeSession) {
              const { minWidth, minHeight } = getResizeMinimums(
                resizeSession.startElement,
              );
              const nextBounds = getResizedBounds(
                resizeSession.startBounds,
                resizeSession.handle,
                pt,
                minWidth,
                minHeight,
              );
              const nextElement = applyResizedBounds(
                resizeSession.startElement,
                nextBounds,
              );
              updateElement(doc, pageId, nextElement);
              setSelectedId(resizeSession.elementId);
              scheduleCursorSync(pt.x, pt.y);
              return;
            }
            if (!locked) {
              queuePointerMove({ x: pt.x, y: pt.y, pressure: force });
            }
            scheduleCursorSync(pt.x, pt.y);
          }
        },
        onPanResponderRelease: () => {
          flushPendingMove();
          const resizeSession = resizeSessionRef.current;
          if (resizeSession) {
            resizeSessionRef.current = null;
            setSelectedId(resizeSession.elementId);
            clearCursor();
            return;
          }
          if (!pinchRef.current) {
            if (!locked) {
              engineRef.current?.onPointerUp();
              setSelectedId(engineRef.current?.getSelectedId() ?? null);
            }
            clearCursor();
          }
          pinchRef.current = null;
        },
        onPanResponderTerminate: () => {
          flushPendingMove();
          const resizeSession = resizeSessionRef.current;
          if (resizeSession) {
            resizeSessionRef.current = null;
            setSelectedId(resizeSession.elementId);
            clearCursor();
            return;
          }
          if (!pinchRef.current) {
            if (!locked) {
              engineRef.current?.onPointerUp();
              setSelectedId(engineRef.current?.getSelectedId() ?? null);
            }
            clearCursor();
          }
          pinchRef.current = null;
        },
      }),
    [
      locked,
      clearCursor,
      scheduleCursorSync,
      viewport,
      toCanvas,
      tool,
      elements,
      selectedId,
      doc,
      pageId,
      onRequestTextEdit,
      flushPendingMove,
      queuePointerMove,
    ],
  );

  const textElements = useMemo(
    () => elements.filter((element) => element.type === "text" || element.type === "sticky"),
    [elements],
  );

  const imageElements = useMemo(
    () => elements.filter((element) => element.type === "image"),
    [elements],
  );

  const selectedElement = useMemo(
    () => elements.find((element) => element.id === selectedId) ?? null,
    [elements, selectedId],
  );

  const selectionBounds = useMemo(
    () => (selectedElement ? getBoundsForElement(selectedElement) : null),
    [selectedElement],
  );
  const canResizeSelectedElement = useMemo(
    () => isResizableElement(selectedElement),
    [selectedElement],
  );

  const remoteCursors = useMemo(
    () =>
      states
        .filter(
          (state) =>
            state.clientId !== awareness.clientID &&
            Boolean(state.cursor) &&
            Boolean(state.user?.name),
        )
        .map((state) => ({
          clientId: state.clientId,
          x: state.cursor?.x ?? 0,
          y: state.cursor?.y ?? 0,
          color: state.user?.color ?? "#F95F4A",
          name: state.user?.name ?? "Guest",
        })),
    [states, awareness.clientID],
  );

  const gridLines = useMemo(() => {
    const minorStep = 24;
    const majorStep = minorStep * 5;
    const minorVertical: number[] = [];
    const minorHorizontal: number[] = [];
    const majorVertical: number[] = [];
    const majorHorizontal: number[] = [];

    if (canvasSize.width <= 0 || canvasSize.height <= 0) {
      return { minorVertical, minorHorizontal, majorVertical, majorHorizontal };
    }

    const vLeft = -viewport.x / viewport.scale;
    const vTop = -viewport.y / viewport.scale;
    const vRight = (canvasSize.width - viewport.x) / viewport.scale;
    const vBottom = (canvasSize.height - viewport.y) / viewport.scale;

    const startMinorX = Math.floor(vLeft / minorStep) * minorStep;
    const startMinorY = Math.floor(vTop / minorStep) * minorStep;
    for (let x = startMinorX; x <= vRight; x += minorStep) {
      minorVertical.push(x);
    }
    for (let y = startMinorY; y <= vBottom; y += minorStep) {
      minorHorizontal.push(y);
    }

    const startMajorX = Math.floor(vLeft / majorStep) * majorStep;
    const startMajorY = Math.floor(vTop / majorStep) * majorStep;
    for (let x = startMajorX; x <= vRight; x += majorStep) {
      majorVertical.push(x);
    }
    for (let y = startMajorY; y <= vBottom; y += majorStep) {
      majorHorizontal.push(y);
    }

    return { minorVertical, minorHorizontal, majorVertical, majorHorizontal };
  }, [canvasSize.height, canvasSize.width, viewport]);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setCanvasSize({
      width: Math.max(0, Math.round(width)),
      height: Math.max(0, Math.round(height)),
    });
  }, []);

  return (
    <View
      style={styles.container}
      onLayout={handleLayout}
      {...(editingElement ? {} : panResponder.panHandlers)}
    >
      <Canvas style={StyleSheet.absoluteFill}>
        <Group
          transform={[
            { translateX: viewport.x },
            { translateY: viewport.y },
            { scale: viewport.scale },
          ]}
        >
        {gridLines.minorVertical.map((x) => (
          <Line
            key={`grid-minor-v-${x}`}
            p1={{ x, y: -viewport.y / viewport.scale - 100 }}
            p2={{ x, y: (canvasSize.height - viewport.y) / viewport.scale + 100 }}
            color="rgba(254,252,217,0.035)"
            strokeWidth={1 / viewport.scale}
          />
        ))}
        {gridLines.minorHorizontal.map((y) => (
          <Line
            key={`grid-minor-h-${y}`}
            p1={{ x: -viewport.x / viewport.scale - 100, y }}
            p2={{ x: (canvasSize.width - viewport.x) / viewport.scale + 100, y }}
            color="rgba(254,252,217,0.035)"
            strokeWidth={1 / viewport.scale}
          />
        ))}
        {gridLines.majorVertical.map((x) => (
          <Line
            key={`grid-major-v-${x}`}
            p1={{ x, y: -viewport.y / viewport.scale - 100 }}
            p2={{ x, y: (canvasSize.height - viewport.y) / viewport.scale + 100 }}
            color="rgba(249,95,74,0.08)"
            strokeWidth={1 / viewport.scale}
          />
        ))}
        {gridLines.majorHorizontal.map((y) => (
          <Line
            key={`grid-major-h-${y}`}
            p1={{ x: -viewport.x / viewport.scale - 100, y }}
            p2={{ x: (canvasSize.width - viewport.x) / viewport.scale + 100, y }}
            color="rgba(249,95,74,0.08)"
            strokeWidth={1 / viewport.scale}
          />
        ))}
        {renderList.map((element) => renderElement(element))}
        {elements
          .filter((element) => element.type === "sticky")
          .map((element) => {
            if (element.type !== "sticky") return null;
            return (
              <Rect
                key={element.id}
                x={element.x}
                y={element.y}
                width={element.width}
                height={element.height}
                color={element.color}
                style="fill"
                opacity={0.94}
              />
            );
          })}
        {elements
          .filter((element) => element.type === "sticky")
          .map((element) => {
            if (element.type !== "sticky") return null;
            return (
              <Rect
                key={`${element.id}-border`}
                x={element.x}
                y={element.y}
                width={element.width}
                height={element.height}
                color="rgba(0,0,0,0.22)"
                style="stroke"
                strokeWidth={1.2}
              />
            );
          })}
        </Group>
      </Canvas>

      {editingElement ? (
        <Pressable
          style={styles.editBackdrop}
          onPressIn={submitEditing}
          accessibilityRole="button"
          accessibilityLabel="Finish text editing"
        />
      ) : null}

      {textElements.map((element) => {
        const isEditing = editingText?.elementId === element.id;

        if (element.type === "text") {
          const left = element.x * viewport.scale + viewport.x;
          const top = element.y * viewport.scale + viewport.y;
          const fontSize = element.fontSize * viewport.scale;

          if (isEditing) {
            return (
              <View
                key={element.id}
                style={{
                  position: "absolute",
                  left,
                  top,
                  minWidth: 120 * viewport.scale,
                  maxWidth: 300 * viewport.scale,
                }}
              >
                <TextInput
                  style={[
                    styles.textEditorInput,
                    {
                      color: element.color,
                      fontSize,
                      fontFamily: WHITEBOARD_FONT_FAMILY,
                      minHeight: fontSize + 8,
                    },
                  ]}
                  value={editingText.text}
                  onChangeText={onEditingTextChange}
                  onSubmitEditing={submitEditing}
                  onBlur={handleEditorBlur}
                  autoFocus
                  multiline
                  blurOnSubmit={false}
                  allowFontScaling={false}
                  placeholder="Type here…"
                  placeholderTextColor="rgba(254,252,217,0.3)"
                />
                <View style={styles.editorActionsRow}>
                  <Pressable
                    onPressIn={cancelEditing}
                    style={[styles.editorActionButton, styles.editorActionCancel]}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel text edit"
                  >
                    <X size={14} color="rgba(254,252,217,0.9)" strokeWidth={2.2} />
                  </Pressable>
                  <Pressable
                    onPressIn={submitEditing}
                    style={[styles.editorActionButton, styles.editorActionConfirm]}
                    accessibilityRole="button"
                    accessibilityLabel="Save text edit"
                  >
                    <Check size={14} color="#060606" strokeWidth={2.4} />
                  </Pressable>
                </View>
              </View>
            );
          }

          return (
            <RNText
              key={element.id}
              pointerEvents="none"
              allowFontScaling={false}
              style={{
                position: "absolute",
                left,
                top,
                color: element.color,
                fontSize,
                fontFamily: WHITEBOARD_FONT_FAMILY,
              }}
            >
              {element.text}
            </RNText>
          );
        }

        if (element.type === "sticky") {
          const left = (element.x + 8) * viewport.scale + viewport.x;
          const top = (element.y + 8) * viewport.scale + viewport.y;
          const fontSize = element.fontSize * viewport.scale;
          const stickyW = (element.width - 16) * viewport.scale;

          if (isEditing) {
            return (
              <View
                key={element.id}
                style={{
                  position: "absolute",
                  left,
                  top,
                  width: stickyW,
                }}
              >
                <TextInput
                  style={[
                    styles.stickyEditorInput,
                    {
                      color: element.textColor,
                      fontSize,
                      fontFamily: WHITEBOARD_FONT_FAMILY,
                      minHeight: fontSize + 8,
                    },
                  ]}
                  value={editingText.text}
                  onChangeText={onEditingTextChange}
                  onSubmitEditing={submitEditing}
                  onBlur={handleEditorBlur}
                  autoFocus
                  multiline
                  blurOnSubmit={false}
                  allowFontScaling={false}
                  placeholder="Type here…"
                  placeholderTextColor="rgba(0,0,0,0.3)"
                />
                <View style={styles.editorActionsRow}>
                  <Pressable
                    onPressIn={cancelEditing}
                    style={[styles.editorActionButton, styles.editorActionCancel]}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel sticky note edit"
                  >
                    <X size={14} color="rgba(254,252,217,0.9)" strokeWidth={2.2} />
                  </Pressable>
                  <Pressable
                    onPressIn={submitEditing}
                    style={[styles.editorActionButton, styles.editorActionConfirm]}
                    accessibilityRole="button"
                    accessibilityLabel="Save sticky note edit"
                  >
                    <Check size={14} color="#060606" strokeWidth={2.4} />
                  </Pressable>
                </View>
              </View>
            );
          }

          return (
            <RNText
              key={element.id}
              pointerEvents="none"
              allowFontScaling={false}
              style={{
                position: "absolute",
                left,
                top,
                color: element.textColor,
                fontSize,
                fontFamily: WHITEBOARD_FONT_FAMILY,
              }}
            >
              {element.text}
            </RNText>
          );
        }

        return null;
      })}

      {imageElements.map((element) => {
        if (element.type !== "image") return null;
        return (
          <Image
            key={element.id}
            source={{ uri: element.src }}
            style={{
              position: "absolute",
              left: element.x * viewport.scale + viewport.x,
              top: element.y * viewport.scale + viewport.y,
              width: element.width * viewport.scale,
              height: element.height * viewport.scale,
              resizeMode: "contain",
            }}
          />
        );
      })}

      {selectionBounds && tool === "select" ? (
        <View
          pointerEvents="none"
          style={[
            styles.selectionBox,
            {
              left: selectionBounds.x * viewport.scale + viewport.x,
              top: selectionBounds.y * viewport.scale + viewport.y,
              width: Math.max(1, selectionBounds.width * viewport.scale),
              height: Math.max(1, selectionBounds.height * viewport.scale),
            },
          ]}
        >
          {canResizeSelectedElement ? (
            <>
              <View style={[styles.selectionHandle, styles.handleTopLeft]} />
              <View style={[styles.selectionHandle, styles.handleTopRight]} />
              <View style={[styles.selectionHandle, styles.handleBottomLeft]} />
              <View style={[styles.selectionHandle, styles.handleBottomRight]} />
            </>
          ) : null}
        </View>
      ) : null}

      {remoteCursors.map((cursor) => (
        <View
          key={cursor.clientId}
          pointerEvents="none"
          style={[
            styles.cursor,
            {
              transform: [
                { translateX: cursor.x * viewport.scale + viewport.x },
                { translateY: cursor.y * viewport.scale + viewport.y },
              ],
            },
          ]}
        >
          <View style={[styles.cursorDot, { backgroundColor: cursor.color }]} />
          <View style={styles.cursorLabel}>
            <RNText style={styles.cursorLabelText} numberOfLines={1}>
              {cursor.name}
            </RNText>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#111111",
    borderRadius: 2,
    overflow: "hidden",
  },
  editBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  textEditorInput: {
    padding: 0,
    margin: 0,
    backgroundColor: "rgba(0,0,0,0.35)",
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: "rgba(249,95,74,0.6)",
    textAlignVertical: "top",
  },
  stickyEditorInput: {
    padding: 0,
    margin: 0,
    textAlignVertical: "top",
  },
  editorActionsRow: {
    marginTop: 8,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
  },
  editorActionButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  editorActionCancel: {
    borderColor: "rgba(254,252,217,0.3)",
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  editorActionConfirm: {
    borderColor: "rgba(249,95,74,0.95)",
    backgroundColor: "rgba(249,95,74,0.95)",
  },
  selectionBox: {
    position: "absolute",
    borderWidth: 1,
    borderColor: "rgba(249,95,74,0.95)",
    borderRadius: 6,
  },
  selectionHandle: {
    position: "absolute",
    width: 10,
    height: 10,
    borderRadius: 3,
    backgroundColor: "#F95F4A",
    borderWidth: 1,
    borderColor: "rgba(254,252,217,0.92)",
  },
  handleTopLeft: {
    left: -5,
    top: -5,
  },
  handleTopRight: {
    right: -5,
    top: -5,
  },
  handleBottomLeft: {
    left: -5,
    bottom: -5,
  },
  handleBottomRight: {
    right: -5,
    bottom: -5,
  },
  cursor: {
    position: "absolute",
  },
  cursorDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    boxShadow: "0 0 12px rgba(0,0,0,0.4)",
  },
  cursorLabel: {
    marginTop: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.65)",
    maxWidth: 140,
  },
  cursorLabelText: {
    color: "rgba(255,255,255,0.82)",
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
});
