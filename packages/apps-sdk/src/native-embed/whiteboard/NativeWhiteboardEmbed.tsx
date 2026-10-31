// The Whiteboard renderer for the native app host (S60 13 c, Q14): the existing SDK canvas
// (`apps/whiteboard/web/components/WhiteboardCanvas`) and nothing else. Every tool, menu, lock and page control is
// native and reaches this page as a bridge command; the page answers with an `ack` after sending its new `status`, so the
// native control's pending state ends on a status that already shows the change. Pinch and two-finger pan stay inside
// the canvas (the meeting never pans); with Apple Pencil only drawing (iOS `prefersPencilOnlyDrawing`) one finger pans.
// No text, toolbar or hint is drawn here: copy and accessibility of the chrome are native. Flat only (no gradients).

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Y from "yjs";
import { WhiteboardCanvas } from "../../apps/whiteboard/web/components/WhiteboardCanvas";
import { useViewport } from "../../apps/whiteboard/shared/hooks/useViewport";
import { useWhiteboardElements } from "../../apps/whiteboard/shared/hooks/useWhiteboardElements";
import { useWhiteboardPages } from "../../apps/whiteboard/shared/hooks/useWhiteboardPages";
import { DEFAULT_TOOL_SETTINGS } from "../../apps/whiteboard/shared/constants/tools";
import { getWhiteboardRoot } from "../../apps/whiteboard/core/doc/index";
import { getBoundsForElement } from "../../apps/whiteboard/core/model/geometry";
import type { ToolKind, ToolSettings } from "../../apps/whiteboard/core/tools/engine";
import {
  INK_COLORS,
  NATIVE_EMBED_LIMITS,
  STROKE_WIDTHS,
  base64CharacterLimit,
  isValidIdentifier,
  isWhiteboardTool,
  type Envelope,
  type NativeToEmbedType,
} from "../protocol";
import {
  payloadBoolean,
  payloadNumber,
  payloadString,
  type CommandResult,
  type EmbedStatusPayload,
  type HostStatus,
  type NativeEmbedSession,
} from "../session";

type Point = { x: number; y: number };
type TouchGesture = { distance: number; center: Point };
type RemoteCursor = { clientId: number; color: string; name: string; x: number; y: number };

const EDIT_COMMANDS: ReadonlySet<string> = new Set([
  "setTool",
  "setColor",
  "setStrokeWidth",
  "setFill",
  "undo",
  "redo",
  "addPage",
  "renamePage",
  "deletePage",
]);

const useHostStatus = (session: NativeEmbedSession): HostStatus =>
  useSyncExternalStore(
    useCallback((listener: () => void) => session.subscribe(listener), [session]),
    () => session.hostStatus,
  );

const centerOf = (points: Point[]): Point => {
  const sum = points.reduce((total, point) => ({ x: total.x + point.x, y: total.y + point.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
};

const distanceOf = (points: Point[]): number => {
  if (points.length < 2) return 0;
  const [a, b] = points;
  return Math.hypot(a.x - b.x, a.y - b.y);
};

/** The canvas as a PNG (base64, no data URL prefix), halved until it fits the bridge bound. */
const exportPng = (canvas: HTMLCanvasElement | null): string | null => {
  if (!canvas) return null;
  const limit = base64CharacterLimit(NATIVE_EMBED_LIMITS.exportBytes);
  let source: HTMLCanvasElement = canvas;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const data = source.toDataURL("image/png");
    const comma = data.indexOf(",");
    const base64 = comma >= 0 ? data.slice(comma + 1) : "";
    if (base64.length > 0 && base64.length <= limit) return base64;
    const smaller = document.createElement("canvas");
    smaller.width = Math.max(1, Math.floor(source.width / 2));
    smaller.height = Math.max(1, Math.floor(source.height / 2));
    const context = smaller.getContext("2d");
    if (!context) return null;
    context.drawImage(source, 0, 0, smaller.width, smaller.height);
    source = smaller;
  }
  return null;
};

export function NativeWhiteboardEmbed({ session }: { session: NativeEmbedSession }) {
  const { doc, awareness } = session;
  const host = useHostStatus(session);
  const readOnly = host.readOnly;
  const [tool, setTool] = useState<ToolKind>("pen");
  const [settings, setSettings] = useState<ToolSettings>({ ...DEFAULT_TOOL_SETTINGS });
  const { viewport, panBy, zoomAt, resetViewport, fitBounds } = useViewport();
  const { pages, activePageId, createPage, renamePage, setActive, deletePage } = useWhiteboardPages(doc, { readOnly });
  const activePage = useMemo(() => pages.find((page) => page.id === activePageId) ?? pages[0], [pages, activePageId]);
  const elements = useWhiteboardElements(doc, activePage?.id ?? null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [undoManager, setUndoManager] = useState<Y.UndoManager | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [editorCount, setEditorCount] = useState(1);

  // Per-person history, as on web: remote updates carry origin "remote", so only your own edits undo.
  useEffect(() => {
    const manager = new Y.UndoManager(getWhiteboardRoot(doc), { captureTimeout: 400 });
    setUndoManager(manager);
    const refresh = () => {
      setCanUndo(manager.canUndo());
      setCanRedo(manager.canRedo());
    };
    refresh();
    manager.on("stack-item-added", refresh);
    manager.on("stack-item-popped", refresh);
    manager.on("stack-cleared", refresh);
    return () => {
      manager.off("stack-item-added", refresh);
      manager.off("stack-item-popped", refresh);
      manager.off("stack-cleared", refresh);
      manager.destroy();
      setUndoManager(null);
    };
  }, [doc]);

  // People present (the native "%lld editing" status).
  useEffect(() => {
    const count = () => {
      let present = 0;
      for (const state of awareness.getStates().values()) {
        if (state && typeof state === "object" && "user" in state) present += 1;
      }
      setEditorCount(Math.max(1, present));
    };
    count();
    awareness.on("change", count);
    return () => {
      awareness.off("change", count);
    };
  }, [awareness]);

  const status = useMemo<EmbedStatusPayload>(
    () => ({
      tool: isWhiteboardTool(tool) ? tool : "pen",
      color: settings.strokeColor,
      strokeWidth: settings.strokeWidth,
      filled: settings.fillColor !== "transparent",
      canUndo: !readOnly && canUndo,
      canRedo: !readOnly && canRedo,
      pageId: isValidIdentifier(activePage?.id) ? activePage.id : "",
      pageName: (activePage?.name ?? "").slice(0, NATIVE_EMBED_LIMITS.pageName),
      pages: pages
        .filter((page) => isValidIdentifier(page.id))
        .slice(0, NATIVE_EMBED_LIMITS.pages)
        .map((page) => ({ id: page.id, name: page.name.slice(0, NATIVE_EMBED_LIMITS.pageName) })),
      elementCount: elements.length,
      editorCount,
    }),
    [tool, settings, readOnly, canUndo, canRedo, activePage, pages, elements.length, editorCount],
  );

  useEffect(() => {
    session.sendStatus(status);
  }, [session, status]);

  const zoomToFit = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (elements.length === 0) {
      resetViewport();
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const element of elements) {
      const bounds = getBoundsForElement(element);
      minX = Math.min(minX, bounds.x);
      minY = Math.min(minY, bounds.y);
      maxX = Math.max(maxX, bounds.x + bounds.width);
      maxY = Math.max(maxY, bounds.y + bounds.height);
    }
    const rect = canvas.getBoundingClientRect();
    fitBounds({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, { width: rect.width, height: rect.height });
  }, [elements, fitBounds, resetViewport]);

  // Host commands. Each one applies, sends the status that shows it, then returns for the ack.
  useEffect(() => {
    const respond = (next: Partial<EmbedStatusPayload>): CommandResult => {
      session.sendStatus({ ...status, ...next });
      return { ok: true };
    };
    const handler = (envelope: Envelope<NativeToEmbedType>): CommandResult => {
      const payload = envelope.payload;
      if (EDIT_COMMANDS.has(envelope.type) && readOnly) return { ok: false, error: "readOnly" };
      switch (envelope.type) {
        case "setTool": {
          const value = payloadString(payload, "tool");
          if (!isWhiteboardTool(value)) return { ok: false, error: "badTool" };
          setTool(value);
          return respond({ tool: value });
        }
        case "setColor": {
          const color = payloadString(payload, "color");
          if (!(INK_COLORS as readonly string[]).includes(color)) return { ok: false, error: "badColor" };
          setSettings((previous) => ({
            ...previous,
            strokeColor: color,
            textColor: color,
            fillColor: previous.fillColor === "transparent" ? "transparent" : color,
          }));
          return respond({ color });
        }
        case "setStrokeWidth": {
          const width = payloadNumber(payload, "width");
          if (width === null || !(STROKE_WIDTHS as readonly number[]).includes(width)) return { ok: false, error: "badWidth" };
          setSettings((previous) => ({ ...previous, strokeWidth: width }));
          return respond({ strokeWidth: width });
        }
        case "setFill": {
          const filled = payloadBoolean(payload, "filled");
          if (filled === null) return { ok: false, error: "badFill" };
          setSettings((previous) => ({ ...previous, fillColor: filled ? previous.strokeColor : "transparent" }));
          return respond({ filled });
        }
        case "undo":
          undoManager?.undo();
          return { ok: true };
        case "redo":
          undoManager?.redo();
          return { ok: true };
        case "setPage": {
          const pageId = payloadString(payload, "pageId");
          if (!pages.some((page) => page.id === pageId)) return { ok: false, error: "noPage" };
          setActive(pageId);
          return { ok: true };
        }
        case "addPage":
          createPage();
          return { ok: true };
        case "renamePage": {
          const pageId = payloadString(payload, "pageId");
          const name = payloadString(payload, "name").trim().slice(0, NATIVE_EMBED_LIMITS.pageName);
          if (!pages.some((page) => page.id === pageId) || name.length === 0) return { ok: false, error: "badRename" };
          renamePage(pageId, name);
          return { ok: true };
        }
        case "deletePage": {
          const pageId = payloadString(payload, "pageId");
          if (pages.length < 2 || !pages.some((page) => page.id === pageId)) return { ok: false, error: "noPage" };
          deletePage(pageId);
          return { ok: true };
        }
        case "zoomToFit":
          zoomToFit();
          return { ok: true };
        case "export": {
          const png = exportPng(canvasRef.current);
          return png ? { ok: true, pngBase64: png } : { ok: false, error: "exportFailed" };
        }
        // Relay messages and commands for another app retain the same rejection as unknown commands.
        case "snapshot":
        case "update":
        case "awareness":
        case "status":
        case "resync":
        case "close":
        case "addEntries":
        case "removeEntry":
        case "shuffle":
        case "sort":
        case "clearEntries":
        case "spin":
        case "setRemoveWinner":
        case "setSounds":
        case "clearResults":
        case "playNow":
        case "enqueue":
        case "request":
        case "approve":
        case "decline":
        case "cancelRequest":
        case "move":
        case "remove":
        default:
          return { ok: false, error: "unknownCommand" };
      }
    };
    session.setCommandHandler(handler);
    return () => {
      session.setCommandHandler(null);
    };
  }, [session, status, readOnly, undoManager, pages, setActive, createPage, renamePage, deletePage, zoomToFit]);

  // Size for the host (resize message), coalesced to one per frame.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        session.sendResize(rect.width, rect.height);
      });
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [session]);

  // Pinch and two-finger pan (and one-finger pan with Pencil-only drawing) never reach the canvas tools.
  const touches = useRef(new Map<number, Point>());
  const gesture = useRef<TouchGesture | null>(null);
  const panStart = useRef<Point | null>(null);

  const endCanvasStroke = useCallback((pointerId: number, point: Point) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.dispatchEvent(
      new PointerEvent("pointerup", { pointerId, pointerType: "touch", clientX: point.x, clientY: point.y, bubbles: true }),
    );
  }, []);

  const onPointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== "touch") return;
      const point = { x: event.clientX, y: event.clientY };
      const first = touches.current.size === 1 ? [...touches.current.entries()][0] : undefined;
      touches.current.set(event.pointerId, point);
      if (touches.current.size >= 2) {
        if (first && !gesture.current) endCanvasStroke(first[0], first[1]);
        const points = [...touches.current.values()];
        gesture.current = { distance: distanceOf(points), center: centerOf(points) };
        event.stopPropagation();
      } else if (host.pencilOnly) {
        panStart.current = point;
        event.stopPropagation();
      }
    },
    [endCanvasStroke, host.pencilOnly],
  );

  const onPointerMoveCapture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== "touch" || !touches.current.has(event.pointerId)) return;
      const point = { x: event.clientX, y: event.clientY };
      touches.current.set(event.pointerId, point);
      const current = gesture.current;
      if (current && touches.current.size >= 2) {
        const points = [...touches.current.values()];
        const center = centerOf(points);
        const distance = distanceOf(points);
        panBy(center.x - current.center.x, center.y - current.center.y);
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect && current.distance > 0 && distance > 0) {
          zoomAt(center.x - rect.left, center.y - rect.top, distance / current.distance);
        }
        gesture.current = { distance, center };
        event.stopPropagation();
        return;
      }
      if (panStart.current) {
        panBy(point.x - panStart.current.x, point.y - panStart.current.y);
        panStart.current = point;
        event.stopPropagation();
      }
    },
    [panBy, zoomAt],
  );

  const onPointerEndCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") return;
    const wasGesture = gesture.current !== null || panStart.current !== null;
    touches.current.delete(event.pointerId);
    if (touches.current.size < 2) gesture.current = null;
    if (touches.current.size === 0) panStart.current = null;
    if (wasGesture) event.stopPropagation();
  }, []);

  // The Pan tool and trackpad or mouse wheel zoom, as on web (WhiteboardWebApp).
  const lastPan = useRef<Point | null>(null);
  const onPanStart = useCallback((x: number, y: number) => {
    lastPan.current = { x, y };
  }, []);
  const onPanMove = useCallback(
    (x: number, y: number) => {
      const last = lastPan.current;
      if (!last) return;
      lastPan.current = { x, y };
      panBy(x - last.x, y - last.y);
    },
    [panBy],
  );
  const onPanEnd = useCallback(() => {
    lastPan.current = null;
  }, []);
  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      zoomAt(event.clientX - rect.left, event.clientY - rect.top, event.deltaY < 0 ? 1.1 : 1 / 1.1);
    },
    [zoomAt],
  );

  const user = useMemo(() => ({ id: host.userId || "guest", name: host.userName || "Guest" }), [host.userId, host.userName]);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      style={{ touchAction: "none", overscrollBehavior: "none" }}
      onPointerDownCapture={onPointerDownCapture}
      onPointerMoveCapture={onPointerMoveCapture}
      onPointerUpCapture={onPointerEndCapture}
      onPointerCancelCapture={onPointerEndCapture}
    >
      {activePage ? (
        <WhiteboardCanvas
          doc={doc}
          awareness={awareness}
          pageId={activePage.id}
          tool={tool}
          settings={settings}
          locked={readOnly}
          user={user}
          canvasRef={canvasRef}
          onToolChange={setTool}
          viewport={viewport}
          onPanStart={onPanStart}
          onPanMove={onPanMove}
          onPanEnd={onPanEnd}
          onWheel={onWheel}
          undoManager={undoManager}
        />
      ) : null}
      <RemoteCursors session={session} viewport={viewport} />
    </div>
  );
}

/** Other people's cursors (awareness), in their own layer so a cursor flood re-renders only this. */
function RemoteCursors({
  session,
  viewport,
}: {
  session: NativeEmbedSession;
  viewport: { translateX: number; translateY: number; scale: number };
}) {
  const { awareness } = session;
  const [cursors, setCursors] = useState<RemoteCursor[]>([]);

  useEffect(() => {
    let frame = 0;
    const read = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next: RemoteCursor[] = [];
        for (const [clientId, state] of awareness.getStates().entries()) {
          if (clientId === awareness.clientID || !state || typeof state !== "object") continue;
          const record = state as { user?: { name?: unknown; color?: unknown }; cursor?: { x?: unknown; y?: unknown } };
          const x = record.cursor?.x;
          const y = record.cursor?.y;
          const name = record.user?.name;
          if (typeof x !== "number" || typeof y !== "number" || typeof name !== "string" || name.length === 0) continue;
          const color = typeof record.user?.color === "string" ? record.user.color : "#a1a1aa";
          next.push({ clientId, color, name: name.slice(0, 40), x, y });
        }
        setCursors(next);
      });
    };
    read();
    awareness.on("change", read);
    return () => {
      cancelAnimationFrame(frame);
      awareness.off("change", read);
    };
  }, [awareness]);

  return (
    <>
      {cursors.map((cursor) => (
        <div
          key={cursor.clientId}
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            pointerEvents: "none",
            transform: `translate(${cursor.x * viewport.scale + viewport.translateX}px, ${cursor.y * viewport.scale + viewport.translateY}px)`,
          }}
        >
          <svg width="16" height="20" viewBox="0 0 16 20" fill={cursor.color} stroke="#ffffff" strokeWidth="1">
            <path d="M0 0L16 12L8 12L4 20L0 0Z" />
          </svg>
          <div
            style={{
              marginLeft: 16,
              marginTop: -2,
              padding: "1px 6px",
              borderRadius: 999,
              backgroundColor: cursor.color,
              color: "#ffffff",
              fontSize: 10,
              fontWeight: 500,
              whiteSpace: "nowrap",
              fontFamily: "system-ui, -apple-system, Roboto, sans-serif",
            }}
          >
            {cursor.name}
          </div>
        </div>
      ))}
    </>
  );
}
