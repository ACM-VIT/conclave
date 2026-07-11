import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { useAppDoc } from "../../../../sdk/hooks/useAppDoc";
import { useAppPresence } from "../../../../sdk/hooks/useAppPresence";
import { useApps } from "../../../../sdk/hooks/useApps";
import { useToolState } from "../../shared/hooks/useToolState";
import { useViewport } from "../../shared/hooks/useViewport";
import { useWhiteboardElements } from "../../shared/hooks/useWhiteboardElements";
import { useWhiteboardPages } from "../../shared/hooks/useWhiteboardPages";
import { getWhiteboardRoot } from "../../core/doc/index";
import { getBoundsForElement } from "../../core/model/geometry";
import { WhiteboardContextBar, WhiteboardToolbar } from "./WhiteboardToolbar";
import { WhiteboardCanvas, type WhiteboardStressResult } from "./WhiteboardCanvas";

const BAR_BG = "rgba(16, 16, 20, 0.94)";
const HAIRLINE = "rgba(255,255,255,0.08)";
const ACCENT = "#F95F4A";

const CAPSULE_STYLE: React.CSSProperties = {
  backgroundColor: BAR_BG,
  border: `1px solid ${HAIRLINE}`,
  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
};

function KeyHint({ label }: { label: string }) {
  return (
    <kbd
      className="rounded px-1.5 py-0.5 font-mono text-[10px]"
      style={{
        backgroundColor: "rgba(255,255,255,0.06)",
        border: "1px solid rgba(255,255,255,0.1)",
        color: "rgba(255,255,255,0.55)",
      }}
    >
      {label}
    </kbd>
  );
}

export function WhiteboardWebApp() {
  const { user, isAdmin, isReadOnly: appReadOnly } = useApps();
  const { doc, awareness, locked } = useAppDoc("whiteboard");
  const { states } = useAppPresence("whiteboard");
  const { tool, setTool, settings, setSettings } = useToolState();
  const { viewport, panBy, zoomAt, resetViewport, fitBounds } = useViewport();
  const lastPanPosRef = useRef<{ x: number; y: number } | null>(null);
  const isReadOnly = Boolean(appReadOnly) || (locked && !isAdmin);
  const {
    pages,
    activePageId,
    createPage,
    renamePage,
    setActive,
    deletePage,
  } = useWhiteboardPages(doc, { readOnly: isReadOnly });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stressToolsEnabled, setStressToolsEnabled] = useState(false);
  const [stressTestRequestId, setStressTestRequestId] = useState<number | null>(null);
  const [stressTestRunning, setStressTestRunning] = useState(false);
  const [stressTestResult, setStressTestResult] = useState<WhiteboardStressResult | null>(null);
  const [renamingPageId, setRenamingPageId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [undoManager, setUndoManager] = useState<Y.UndoManager | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const activePage = useMemo(() => {
    return pages.find((page) => page.id === activePageId) ?? pages[0];
  }, [pages, activePageId]);

  const elements = useWhiteboardElements(doc, activePage?.id ?? null);

  // Per-user history: remote updates arrive with origin "remote", so the default
  // tracked origin (null, our local transactions) only ever undoes your own work.
  useEffect(() => {
    const manager = new Y.UndoManager(getWhiteboardRoot(doc), {
      captureTimeout: 400,
    });
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
      setCanUndo(false);
      setCanRedo(false);
    };
  }, [doc]);

  const handleUndo = useCallback(() => {
    undoManager?.undo();
  }, [undoManager]);

  const handleRedo = useCallback(() => {
    undoManager?.redo();
  }, [undoManager]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("wbStress");
    if (!mode) return;
    setStressToolsEnabled(true);
    if (mode === "run" && !isReadOnly) {
      setStressTestRunning(true);
      setStressTestRequestId((value) => (value ?? 0) + 1);
    }
  }, [isReadOnly]);

  const handlePanStart = useCallback((screenX: number, screenY: number) => {
    lastPanPosRef.current = { x: screenX, y: screenY };
  }, []);

  const handlePanMove = useCallback((screenX: number, screenY: number) => {
    const last = lastPanPosRef.current;
    if (!last) return;
    const dx = screenX - last.x;
    const dy = screenY - last.y;
    lastPanPosRef.current = { x: screenX, y: screenY };
    panBy(dx, dy);
  }, [panBy]);

  const handlePanEnd = useCallback(() => {
    lastPanPosRef.current = null;
  }, []);

  const handleViewportWheel = useCallback((event: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    zoomAt(screenX, screenY, factor);
  }, [zoomAt]);

  const zoomFromCenter = useCallback(
    (factor: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      zoomAt(rect.width / 2, rect.height / 2, factor);
    },
    [zoomAt]
  );

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
    fitBounds(
      { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      { width: rect.width, height: rect.height }
    );
  }, [elements, fitBounds, resetViewport]);

  const triggerStressTest = useCallback(() => {
    if (isReadOnly || stressTestRunning) return;
    setStressTestRunning(true);
    setStressTestResult(null);
    setStressTestRequestId((value) => (value ?? 0) + 1);
  }, [isReadOnly, stressTestRunning]);

  const handleStressTestComplete = useCallback((result: WhiteboardStressResult) => {
    setStressTestResult(result);
    setStressTestRunning(false);
  }, []);

  useEffect(() => {
    const toolsByKey: Record<string, typeof tool> = {
      "1": "select",
      "2": "pen",
      "3": "highlighter",
      "4": "eraser",
      "5": "rect",
      "6": "ellipse",
      "7": "line",
      a: "arrow",
      "8": "text",
      "9": "sticky",
      h: "pan",
      l: "laser",
    };
    const toolsByCode: Record<string, typeof tool> = {
      Digit1: "select",
      Digit2: "pen",
      Digit3: "highlighter",
      Digit4: "eraser",
      Digit5: "rect",
      Digit6: "ellipse",
      Digit7: "line",
      KeyA: "arrow",
      Digit8: "text",
      Digit9: "sticky",
      KeyH: "pan",
      KeyL: "laser",
      Numpad1: "select",
      Numpad2: "pen",
      Numpad3: "highlighter",
      Numpad4: "eraser",
      Numpad5: "rect",
      Numpad6: "ellipse",
      Numpad7: "line",
      Numpad8: "text",
      Numpad9: "sticky",
    };

    const widthSteps = [2, 3, 5, 8, 12];
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (target?.isContentEditable || tag === "input" || tag === "textarea" || tag === "select") {
        return;
      }

      const rawKey = event.key;
      const key = rawKey.toLowerCase();
      const withModifier = event.metaKey || event.ctrlKey;

      if (withModifier && !event.altKey && key === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
        return;
      }
      if (event.ctrlKey && !event.metaKey && !event.shiftKey && key === "y") {
        event.preventDefault();
        handleRedo();
        return;
      }

      // Leave every other modifier combo to the browser (tab switching, zoom)
      if (withModifier || event.altKey) return;

      const mapped = toolsByCode[event.code] ?? toolsByKey[rawKey] ?? toolsByKey[key];
      if (mapped) {
        event.preventDefault();
        setTool(mapped);
        return;
      }

      if (key === "escape") {
        setTool("select");
        return;
      }

      if (key === "0") {
        event.preventDefault();
        resetViewport();
        return;
      }
      if (key === "=" || key === "+") {
        event.preventDefault();
        zoomFromCenter(1.2);
        return;
      }
      if (key === "-") {
        event.preventDefault();
        zoomFromCenter(1 / 1.2);
        return;
      }

      if (key === "[" || key === "]") {
        event.preventDefault();
        const currentIndex = widthSteps.indexOf(settings.strokeWidth);
        if (key === "[") {
          const nextIndex = currentIndex <= 0 ? 0 : currentIndex - 1;
          setSettings({ ...settings, strokeWidth: widthSteps[nextIndex] });
        } else {
          const nextIndex =
            currentIndex < 0
              ? 0
              : currentIndex >= widthSteps.length - 1
                ? widthSteps.length - 1
                : currentIndex + 1;
          setSettings({ ...settings, strokeWidth: widthSteps[nextIndex] });
        }
      }
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [handleRedo, handleUndo, resetViewport, setTool, setSettings, settings, zoomFromCenter]);

  const handleExport = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement("a");
    link.href = canvas.toDataURL("image/png");
    link.download = `whiteboard-${Date.now()}.png`;
    link.click();
  }, []);

  const commitRename = useCallback(() => {
    if (!renamingPageId) return;
    const trimmed = renameDraft.trim();
    if (trimmed.length > 0) {
      renamePage(renamingPageId, trimmed.slice(0, 40));
    }
    setRenamingPageId(null);
    setRenameDraft("");
  }, [renamingPageId, renameDraft, renamePage]);

  const remoteCursors = useMemo(
    () =>
      states
        .filter(
          (state) =>
            state.cursor &&
            state.user?.name &&
            state.clientId !== awareness.clientID,
        )
        .map((state) => ({
          clientId: state.clientId,
          color: state.user?.color ?? "#a1a1aa",
          name: state.user?.name ?? "",
          x: (state.cursor?.x ?? 0) * viewport.scale + viewport.translateX,
          y: (state.cursor?.y ?? 0) * viewport.scale + viewport.translateY,
        })),
    [awareness.clientID, states, viewport],
  );

  const showEmptyHint = Boolean(activePage) && elements.length === 0 && !isReadOnly;

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{ backgroundColor: "#121212" }}
    >
      {activePage ? (
        <div className="absolute inset-0">
          <WhiteboardCanvas
            doc={doc}
            awareness={awareness}
            pageId={activePage.id}
            tool={tool}
            settings={settings}
            locked={isReadOnly}
            user={user}
            canvasRef={canvasRef}
            onToolChange={setTool}
            stressTestRequestId={stressTestRequestId}
            onStressTestComplete={handleStressTestComplete}
            viewport={viewport}
            onPanStart={handlePanStart}
            onPanMove={handlePanMove}
            onPanEnd={handlePanEnd}
            onWheel={handleViewportWheel}
            undoManager={undoManager}
          />
        </div>
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[13px] text-[#71717a]">
          Loading whiteboard
        </div>
      )}

      {showEmptyHint ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3 px-6 text-center">
            <div
              className="flex h-11 w-11 items-center justify-center rounded-2xl"
              style={{ backgroundColor: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.45)" }}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 19l7-7 3 3-7 7-3-3z" />
                <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
                <path d="M2 2l7.586 7.586" />
              </svg>
            </div>
            <p className="text-[14px] font-medium" style={{ color: "rgba(255,255,255,0.7)" }}>
              A blank board
            </p>
            <p className="max-w-[260px] text-[12px] leading-relaxed" style={{ color: "rgba(255,255,255,0.38)" }}>
              Sketch, drop sticky notes, or point things out with the laser. Everyone in the call sees it live.
            </p>
            <div className="mt-1 flex items-center gap-2 text-[11px]" style={{ color: "rgba(255,255,255,0.35)" }}>
              <KeyHint label="2" /> pen
              <span className="mx-0.5">·</span>
              <KeyHint label="9" /> sticky
              <span className="mx-0.5">·</span>
              <KeyHint label="L" /> laser
            </div>
          </div>
        </div>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 top-3 flex flex-col items-center gap-2 px-3">
        <div
          className="pointer-events-auto max-w-full overflow-x-auto overflow-y-hidden rounded-full"
          style={{
            WebkitOverflowScrolling: "touch",
            touchAction: "pan-x",
            overscrollBehaviorX: "contain",
          }}
        >
          <div className="min-w-max">
            <WhiteboardToolbar
              tool={tool}
              onToolChange={setTool}
              settings={settings}
              onSettingsChange={setSettings}
              locked={isReadOnly}
              onExport={handleExport}
              onUndo={handleUndo}
              onRedo={handleRedo}
              canUndo={canUndo}
              canRedo={canRedo}
            />
          </div>
        </div>
        <div className="pointer-events-auto">
          <WhiteboardContextBar
            tool={tool}
            settings={settings}
            onSettingsChange={setSettings}
            locked={isReadOnly}
          />
        </div>
      </div>

      {locked ? (
        <div
          className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full px-3 py-2 text-[11px] font-medium"
          style={{
            ...CAPSULE_STYLE,
            color: "#fbbf24",
          }}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0110 0v4" />
          </svg>
          {isAdmin ? "Locked for others" : "View only"}
        </div>
      ) : null}

      {stressToolsEnabled ? (
        <div className="absolute right-3 top-3 flex items-center gap-2">
          <button
            type="button"
            onClick={triggerStressTest}
            disabled={isReadOnly || stressTestRunning}
            className="rounded-full px-3 py-2 text-[11px] font-medium text-[#d8d8d8] transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
            style={CAPSULE_STYLE}
          >
            {stressTestRunning ? "Running stress" : "Run stress test"}
          </button>
          {stressTestResult ? (
            <div
              className="whitespace-nowrap rounded-full px-3 py-2 text-[10px] text-[#b8b8b8]"
              style={CAPSULE_STYLE}
            >
              {`${Math.round(stressTestResult.durationMs)}ms · ${stressTestResult.strokeCount} strokes · ${stressTestResult.queuedMoveEvents} moves`}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3">
        <div
          className="pointer-events-auto flex max-w-[62%] items-center gap-1 overflow-x-auto overflow-y-hidden rounded-full px-1.5 py-1.5 backdrop-blur-md sm:max-w-[70%]"
          style={{
            ...CAPSULE_STYLE,
            WebkitOverflowScrolling: "touch",
            touchAction: "pan-x",
            overscrollBehaviorX: "contain",
          }}
        >
          {pages.map((page) => {
            const isActive = page.id === activePage?.id;
            const isRenaming = renamingPageId === page.id;
            if (isRenaming) {
              return (
                <input
                  key={page.id}
                  autoFocus
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") commitRename();
                    if (event.key === "Escape") {
                      setRenamingPageId(null);
                      setRenameDraft("");
                    }
                  }}
                  className="h-7 w-24 shrink-0 rounded-full px-3 text-[11px] font-medium outline-none"
                  style={{
                    backgroundColor: "rgba(255,255,255,0.08)",
                    border: `1px solid ${ACCENT}`,
                    color: "#fafafa",
                  }}
                />
              );
            }
            return (
              <button
                key={page.id}
                type="button"
                onClick={() => setActive(page.id)}
                onDoubleClick={() => {
                  if (isReadOnly) return;
                  setRenamingPageId(page.id);
                  setRenameDraft(page.name);
                }}
                title={isReadOnly ? page.name : `${page.name} (double-click to rename)`}
                className="group flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-3 text-[11px] font-medium transition-colors duration-100 cursor-pointer"
                style={
                  isActive
                    ? { backgroundColor: "rgba(249,95,74,0.16)", color: ACCENT }
                    : { color: "rgba(255,255,255,0.5)" }
                }
              >
                {page.name}
                {isActive && !isReadOnly && pages.length > 1 ? (
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={`Delete ${page.name}`}
                    title={`Delete ${page.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      deletePage(page.id);
                    }}
                    className="-mr-1 flex h-4 w-4 items-center justify-center rounded-full opacity-60 transition-opacity hover:opacity-100"
                  >
                    <svg
                      width="8"
                      height="8"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </span>
                ) : null}
              </button>
            );
          })}
          {!isReadOnly ? (
            <button
              type="button"
              onClick={() => createPage()}
              title="New page"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#8b8b8b] transition-colors hover:bg-white/5 hover:text-[#d4d4d8] cursor-pointer"
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      <div
        className="absolute bottom-3 right-3 flex items-center gap-0.5 rounded-full px-1.5 py-1 backdrop-blur-md"
        style={CAPSULE_STYLE}
      >
        <button
          type="button"
          onClick={() => zoomFromCenter(1 / 1.2)}
          title="Zoom out (-)"
          className="flex h-7 w-7 items-center justify-center rounded-full text-[#8b8b8b] transition-colors hover:bg-white/5 hover:text-[#d4d4d8] cursor-pointer"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button
          type="button"
          onClick={resetViewport}
          title="Reset zoom (0)"
          className="h-7 min-w-[46px] rounded-full px-1 text-center text-[11px] font-medium tabular-nums text-[#b8b8b8] transition-colors hover:bg-white/5 hover:text-white cursor-pointer"
        >
          {Math.round(viewport.scale * 100)}%
        </button>
        <button
          type="button"
          onClick={() => zoomFromCenter(1.2)}
          title="Zoom in (+)"
          className="flex h-7 w-7 items-center justify-center rounded-full text-[#8b8b8b] transition-colors hover:bg-white/5 hover:text-[#d4d4d8] cursor-pointer"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <div className="mx-0.5 h-4 w-px" style={{ backgroundColor: HAIRLINE }} />
        <button
          type="button"
          onClick={zoomToFit}
          title="Zoom to fit"
          className="flex h-7 w-7 items-center justify-center rounded-full text-[#8b8b8b] transition-colors hover:bg-white/5 hover:text-[#d4d4d8] cursor-pointer"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 3H5a2 2 0 00-2 2v3" />
            <path d="M16 3h3a2 2 0 012 2v3" />
            <path d="M8 21H5a2 2 0 01-2-2v-3" />
            <path d="M16 21h3a2 2 0 002-2v-3" />
          </svg>
        </button>
      </div>

      {remoteCursors.map((cursor) => (
        <div
          key={cursor.clientId}
          className="pointer-events-none absolute z-50"
          style={{
            transform: `translate(${cursor.x}px, ${cursor.y}px)`,
            transition: "transform 80ms linear",
          }}
        >
          <svg
            width="16"
            height="20"
            viewBox="0 0 16 20"
            fill={cursor.color}
            stroke="white"
            strokeWidth="1"
            style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.4))" }}
          >
            <path d="M0 0L16 12L8 12L4 20L0 0Z" />
          </svg>
          <div
            className="-mt-0.5 ml-4 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
            style={{
              backgroundColor: cursor.color,
              boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
            }}
          >
            {cursor.name}
          </div>
        </div>
      ))}
    </div>
  );
}
