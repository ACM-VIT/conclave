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
import { getBoundsForElement, hitTestElement } from "../../core/model/geometry";

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
}: WhiteboardCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const internalCanvasRef = useRef<HTMLCanvasElement>(null);
  const resolvedCanvasRef = canvasRef ?? internalCanvasRef;
  const engineRef = useRef<ToolEngine | null>(null);
  const elements = useWhiteboardElements(doc, pageId);
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const latestCursorRef = useRef<{ x: number; y: number } | null>(null);
  const textEditorRef = useRef<HTMLTextAreaElement>(null);
  const [imageVersion, setImageVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingElementId, setEditingElementId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");

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
    setEditingElementId(null);
    setEditingText("");
  }, [pageId]);

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
      // Sync immediately — no RAF batching. Awareness is already lightweight.
      awareness.setLocalStateField("cursor", { x, y });
    },
    [awareness]
  );

  const clearCursor = useCallback(() => {
    latestCursorRef.current = null;
    awareness.setLocalStateField("cursor", null);
  }, [awareness]);

  useEffect(() => {
    return () => {
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

  const render = useCallback(() => {
    const canvas = resolvedCanvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const rect = container.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    canvas.width = rect.width * scale;
    canvas.height = rect.height * scale;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    // Hide the element being edited so the textarea overlays it cleanly
    const filteredElements = editingElementId
      ? elements.filter((el) => el.id !== editingElementId)
      : elements;
    const renderList = buildRenderList(filteredElements);
    renderCanvas(ctx, renderList, rect.width, rect.height, imageCacheRef.current);
  }, [elements, editingElementId, imageVersion]);

  useResizeObserver(containerRef, render);

  useEffect(() => {
    render();
  }, [render]);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (editingElementId) {
        commitEditing();
      }
      const rect = event.currentTarget.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top, pressure: event.pressure };
      event.currentTarget.setPointerCapture(event.pointerId);
      if (!locked) {
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
    [commitEditing, editingElementId, locked, onToolChange, scheduleCursorSync, startEditingById, tool]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top, pressure: event.pressure };
      if (!locked && event.buttons) {
        engineRef.current?.onPointerMove(point);
      }
      scheduleCursorSync(point.x, point.y);
    },
    [locked, scheduleCursorSync]
  );

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!locked) {
      engineRef.current?.onPointerUp();
      setSelectedId(engineRef.current?.getSelectedId() ?? null);
    }
    clearCursor();
  }, [locked, clearCursor]);

  const handlePointerLeave = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      handlePointerUp(event);
    },
    [handlePointerUp]
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
    };
  }, [editingElement, editingTextBounds]);

  const selectionBounds = useMemo(
    () => (selectedElement ? getBoundsForElement(selectedElement) : null),
    [selectedElement]
  );

  return (
    <div ref={containerRef} className="w-full h-full relative">
      <canvas
        ref={resolvedCanvasRef}
        className="w-full h-full touch-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
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
          {[
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
          ))}
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
