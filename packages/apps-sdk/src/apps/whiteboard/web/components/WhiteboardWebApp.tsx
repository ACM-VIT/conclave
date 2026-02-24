import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppDoc } from "../../../../sdk/hooks/useAppDoc";
import { useAppPresence } from "../../../../sdk/hooks/useAppPresence";
import { useApps } from "../../../../sdk/hooks/useApps";
import { useToolState } from "../../shared/hooks/useToolState";
import { WhiteboardToolbar } from "./WhiteboardToolbar";
import { WhiteboardCanvas, type WhiteboardStressResult } from "./WhiteboardCanvas";
import { useWhiteboardPages } from "../../shared/hooks/useWhiteboardPages";

export function WhiteboardWebApp() {
  const { user, isAdmin } = useApps();
  const { doc, awareness, locked } = useAppDoc("whiteboard");
  const { states } = useAppPresence("whiteboard");
  const { tool, setTool, settings, setSettings } = useToolState();
  const isReadOnly = locked && !isAdmin;
  const {
    pages,
    activePageId,
    createPage,
    setActive,
    deletePage,
  } = useWhiteboardPages(doc, { readOnly: isReadOnly });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stressToolsEnabled, setStressToolsEnabled] = useState(false);
  const [stressTestRequestId, setStressTestRequestId] = useState<number | null>(null);
  const [stressTestRunning, setStressTestRunning] = useState(false);
  const [stressTestResult, setStressTestResult] = useState<WhiteboardStressResult | null>(null);

  const activePage = useMemo(() => {
    return pages.find((page) => page.id === activePageId) ?? pages[0];
  }, [pages, activePageId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("wbStress");
    const enableViaQuery = Boolean(mode);
    const enableInDev = process.env.NODE_ENV !== "production";
    const shouldEnable =
      enableViaQuery ||
      (enableInDev && window.matchMedia("(min-width: 768px)").matches);
    if (!shouldEnable) return;

    setStressToolsEnabled(true);
    if (mode === "run" && !isReadOnly) {
      setStressTestRunning(true);
      setStressTestRequestId((value) => (value ?? 0) + 1);
    }
  }, [isReadOnly]);

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
      const mapped = toolsByCode[event.code] ?? toolsByKey[rawKey] ?? toolsByKey[key];
      if (mapped) {
        event.preventDefault();
        setTool(mapped);
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
  }, [setTool, setSettings, settings]);

  const handleExport = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement("a");
    link.href = canvas.toDataURL("image/png");
    link.download = `whiteboard-${Date.now()}.png`;
    link.click();
  };

  if (!activePage) {
    return (
      <div className="w-full h-full flex items-center justify-center text-[#b8b8b8]">
        <div className="flex flex-col items-center gap-3">
          <span className="text-sm">Loading whiteboard…</span>
        </div>
      </div>
    );
  }

  const remoteCursors = states.filter(
    (state) =>
      state.cursor &&
      state.user?.name &&
      state.clientId !== awareness.clientID,
  );

  return (
    <div
      className="w-full h-full relative overflow-hidden flex flex-col"
      style={{ backgroundColor: "#121212" }}
    >
      <div className="flex-1 relative min-h-0">
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
          />
        </div>

        <div className="absolute inset-0 pointer-events-none p-3 sm:p-4">
          <div className="pointer-events-auto w-full rounded-2xl border border-white/5 bg-[#0b0b0f]/90 backdrop-blur-md px-2.5 py-2 shadow-[0_10px_24px_rgba(0,0,0,0.35)]">
            <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex flex-wrap items-center gap-2 shrink-0">
              {locked ? (
                <div
                  className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-[11px] font-medium text-amber-300"
                  style={{
                    backgroundColor: "rgba(251, 191, 36, 0.1)",
                    boxShadow: "inset 0 0 0 1px rgba(251, 191, 36, 0.2)",
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0110 0v4" />
                  </svg>
                  Locked
                </div>
              ) : null}
              {stressToolsEnabled ? (
                <>
                  <button
                    type="button"
                    onClick={triggerStressTest}
                    disabled={isReadOnly || stressTestRunning}
                    className="rounded-lg px-3 py-2 text-[11px] font-medium text-[#d8d8d8] transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer hover:text-white"
                    style={{
                      backgroundColor: "#2b2b33",
                      boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
                    }}
                  >
                    {stressTestRunning ? "Running stress..." : "Run stress test"}
                  </button>
                  {stressTestResult ? (
                    <div
                      className="rounded-lg px-3 py-2 text-[10px] text-[#b8b8b8] whitespace-nowrap"
                      style={{
                        backgroundColor: "#232329",
                        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.04)",
                      }}
                    >
                      {`${Math.round(stressTestResult.durationMs)}ms · ${stressTestResult.strokeCount} strokes · ${stressTestResult.queuedMoveEvents} moves`}
                    </div>
                  ) : null}
                </>
              ) : null}
              </div>

              <div className="order-2 w-full sm:order-none sm:flex sm:flex-1 sm:justify-center">
                <div
                  className="mx-auto max-w-full overflow-x-auto overflow-y-hidden"
                  style={{
                    WebkitOverflowScrolling: "touch",
                    touchAction: "pan-x",
                    overscrollBehaviorX: "contain",
                  }}
                >
                  <div className="inline-flex min-w-max justify-center">
                    <WhiteboardToolbar
                      tool={tool}
                      onToolChange={setTool}
                      settings={settings}
                      onSettingsChange={setSettings}
                      locked={isReadOnly}
                      onExport={handleExport}
                    />
                  </div>
                </div>
              </div>

              <div className="hidden sm:block w-24 shrink-0" />
            </div>
          </div>
        </div>

        {remoteCursors.map((state) => (
          <div
            key={state.clientId}
            className="absolute pointer-events-none z-50"
            style={{
              transform: `translate(${state.cursor?.x ?? 0}px, ${state.cursor?.y ?? 0}px)`,
              transition: "transform 80ms linear",
            }}
          >
            <svg
              width="16"
              height="20"
              viewBox="0 0 16 20"
              fill={state.user?.color ?? "#a8a5ff"}
              stroke="white"
              strokeWidth="1"
              style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.4))" }}
            >
              <path d="M0 0L16 12L8 12L4 20L0 0Z" />
            </svg>
            <div
              className="ml-4 -mt-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium text-white whitespace-nowrap"
              style={{
                backgroundColor: state.user?.color ?? "#a8a5ff",
                boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
              }}
            >
              {state.user?.name ?? ""}
            </div>
          </div>
        ))}
      </div>

      <div
        className="flex items-center gap-1 px-3 py-1.5 border-t border-white/5 shrink-0 overflow-x-auto overflow-y-hidden"
        style={{
          backgroundColor: "#1a1a1f",
          paddingBottom: "calc(6px + env(safe-area-inset-bottom))",
          WebkitOverflowScrolling: "touch",
          touchAction: "pan-x",
          overscrollBehaviorX: "contain",
        }}
      >
        {pages.map((page) => (
          <button
            key={page.id}
            type="button"
            onClick={() => setActive(page.id)}
            className={`
              px-3 py-1.5 rounded text-[11px] font-medium transition-all duration-100 cursor-pointer
              ${
                page.id === activePage.id
                  ? "bg-[#2e2d39] text-[#e0dfff] shadow-[inset_0_0_0_1px_rgba(169,165,255,0.3)]"
                  : "text-[#8b8b8b] hover:text-[#c4c4c4] hover:bg-white/5"
              }
            `}
          >
            {page.name}
          </button>
        ))}
        <div className="w-px h-4 bg-white/10 mx-1" />
        <button
          type="button"
          onClick={() => createPage()}
          disabled={isReadOnly}
          title="New page"
          className="flex items-center justify-center w-6 h-6 rounded text-[#8b8b8b] hover:text-[#c4c4c4] hover:bg-white/5 transition-all duration-100 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => deletePage(activePage.id)}
          disabled={isReadOnly || pages.length <= 1}
          title="Delete page"
          className="flex items-center justify-center w-6 h-6 rounded text-[#8b8b8b] hover:text-[#db6965] hover:bg-white/5 transition-all duration-100 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
