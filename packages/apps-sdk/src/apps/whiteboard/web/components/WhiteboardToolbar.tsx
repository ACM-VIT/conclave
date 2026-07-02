import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ToolKind, ToolSettings } from "../../core/tools/engine";
import { STICKY_COLORS, TOOL_COLORS } from "../../shared/constants/tools";

const ACCENT = "#F95F4A";
const BAR_BG = "rgba(16, 16, 20, 0.94)";
const POPUP_BG = "#16161b";
const HAIRLINE = "rgba(255,255,255,0.08)";
const ICON_IDLE = "rgba(255,255,255,0.5)";
const ICON_HOVER = "rgba(255,255,255,0.92)";

const Icon = ({ children, size = 16 }: { children: React.ReactNode; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);

const SelectIcon = () => (
  <Icon>
    <path d="M5 3l14 8-7 2-3 7z" />
    <path d="M12 13l5 5" />
  </Icon>
);

const PanIcon = () => (
  <Icon>
    <path d="M18 11V6a2 2 0 00-2-2v0a2 2 0 00-2 2v0" />
    <path d="M14 10V4a2 2 0 00-2-2v0a2 2 0 00-2 2v0" />
    <path d="M10 10.5V6a2 2 0 00-2-2v0a2 2 0 00-2 2v4" />
    <path d="M18 11a2 2 0 012 2v3a8 8 0 01-16 0v-5a2 2 0 012-2h0" />
  </Icon>
);

const PenIcon = () => (
  <Icon>
    <path d="M12 19l7-7 3 3-7 7-3-3z" />
    <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
    <path d="M2 2l7.586 7.586" />
    <circle cx="11" cy="11" r="2" />
  </Icon>
);

const HighlighterIcon = () => (
  <Icon>
    <path d="M18 2L9 11l-1 5 5-1 9-9-4-4z" />
    <path d="M4 20h16" />
  </Icon>
);

const EraserIcon = () => (
  <Icon>
    <path d="M7 21h10" />
    <path d="M19.4 15.4L8.7 4.7a2.1 2.1 0 00-3 0L2.5 7.9a2.1 2.1 0 000 3l7 7" />
    <path d="M5.3 10.7l8.5 8.5" />
  </Icon>
);

const RectIcon = () => (
  <Icon>
    <rect x="3" y="3" width="18" height="18" rx="2" />
  </Icon>
);

const EllipseIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
  </Icon>
);

const LineIcon = () => (
  <Icon>
    <line x1="5" y1="19" x2="19" y2="5" />
  </Icon>
);

const ArrowIcon = () => (
  <Icon>
    <line x1="4" y1="19" x2="20" y2="3" />
    <polyline points="13 3 20 3 20 10" />
  </Icon>
);

const TextIcon = () => (
  <Icon>
    <polyline points="4 7 4 4 20 4 20 7" />
    <line x1="9" y1="20" x2="15" y2="20" />
    <line x1="12" y1="4" x2="12" y2="20" />
  </Icon>
);

const StickyIcon = () => (
  <Icon>
    <path d="M15.5 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V8.5L15.5 3z" />
    <polyline points="14 3 14 8 21 8" />
  </Icon>
);

const LaserIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
    <path d="M12 5V3" />
    <path d="M12 21v-2" />
    <path d="M5 12H3" />
    <path d="M21 12h-2" />
    <path d="M7 7L5.6 5.6" />
    <path d="M18.4 18.4L17 17" />
    <path d="M17 7l1.4-1.4" />
    <path d="M5.6 18.4L7 17" />
  </Icon>
);

const UndoIcon = () => (
  <Icon>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 010 11H11" />
  </Icon>
);

const RedoIcon = () => (
  <Icon>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 000 11H13" />
  </Icon>
);

const ExportIcon = () => (
  <Icon>
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </Icon>
);

type ShapeKind = Extract<ToolKind, "rect" | "ellipse" | "line" | "arrow">;

const SHAPE_KINDS: { id: ShapeKind; label: string; key: string; icon: React.FC }[] = [
  { id: "rect", label: "Rectangle", key: "5", icon: RectIcon },
  { id: "ellipse", label: "Ellipse", key: "6", icon: EllipseIcon },
  { id: "line", label: "Line", key: "7", icon: LineIcon },
  { id: "arrow", label: "Arrow", key: "A", icon: ArrowIcon },
];

const isShapeKind = (tool: ToolKind): tool is ShapeKind =>
  tool === "rect" || tool === "ellipse" || tool === "line" || tool === "arrow";

const normalizeHex = (raw: string): string | null => {
  const stripped = raw.replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(stripped)) return `#${stripped}`;
  if (/^[0-9a-f]{3}$/.test(stripped)) {
    const [r, g, b] = stripped.split("");
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return null;
};

const perceivedBrightness = (hex: string): number => {
  const c = hex.replace("#", "").padEnd(6, "0");
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000;
};

const STROKE_WIDTHS = [2, 3, 5, 8, 12] as const;

const GAP = 10;

/** Shared portal popover state: position under the trigger, close on outside click or scroll. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<React.CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const toggle = useCallback(() => {
    const trigger = triggerRef.current;
    if (trigger) {
      const rect = trigger.getBoundingClientRect();
      setStyle({
        position: "fixed",
        left: rect.left + rect.width / 2,
        top: rect.bottom + GAP,
        transform: "translate(-50%, 0)",
        zIndex: 9999,
      });
    }
    setOpen((prev) => !prev);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        popupRef.current &&
        !popupRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onDismiss = () => setOpen(false);
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("scroll", onDismiss, true);
    window.addEventListener("resize", onDismiss);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("resize", onDismiss);
    };
  }, [open]);

  return { open, style, triggerRef, popupRef, toggle, close };
}

function PopupCard({
  popupRef,
  style,
  children,
  width,
}: {
  popupRef: React.RefObject<HTMLDivElement | null>;
  style: React.CSSProperties;
  children: React.ReactNode;
  width?: number;
}) {
  return createPortal(
    <div ref={popupRef} style={style}>
      <div
        className="rounded-2xl p-2.5"
        style={{
          backgroundColor: POPUP_BG,
          border: `1px solid ${HAIRLINE}`,
          boxShadow: "0 12px 32px rgba(0,0,0,0.55)",
          width,
        }}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

function BarButton({
  label,
  active,
  disabled,
  onClick,
  children,
  buttonRef,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      ref={buttonRef}
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      title={label}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors duration-100 ${
        disabled ? "opacity-25 cursor-not-allowed" : "cursor-pointer"
      }`}
      style={
        active
          ? {
              backgroundColor: "rgba(249,95,74,0.16)",
              color: ACCENT,
            }
          : {
              backgroundColor: hovered && !disabled ? "rgba(255,255,255,0.06)" : "transparent",
              color: hovered && !disabled ? ICON_HOVER : ICON_IDLE,
            }
      }
    >
      {children}
    </button>
  );
}

function BarDivider() {
  return <div className="mx-1 h-5 w-px shrink-0" style={{ backgroundColor: HAIRLINE }} />;
}

/** One slot for all four shapes: click activates the current kind, caret opens the picker. */
function ShapeSlot({
  tool,
  onToolChange,
  disabled,
}: {
  tool: ToolKind;
  onToolChange: (tool: ToolKind) => void;
  disabled: boolean;
}) {
  const { open, style, triggerRef, popupRef, toggle, close } = usePopover();
  const [lastShape, setLastShape] = useState<ShapeKind>("rect");
  const active = isShapeKind(tool);
  const current = active ? tool : lastShape;
  const CurrentIcon = SHAPE_KINDS.find((kind) => kind.id === current)?.icon ?? RectIcon;

  useEffect(() => {
    if (isShapeKind(tool)) setLastShape(tool);
  }, [tool]);

  return (
    <div className="relative flex shrink-0 items-center">
      <BarButton
        label={`Shapes (${SHAPE_KINDS.find((kind) => kind.id === current)?.key ?? "5"})`}
        active={active}
        disabled={disabled}
        buttonRef={triggerRef}
        onClick={() => {
          if (active) {
            toggle();
          } else {
            onToolChange(current);
          }
        }}
      >
        <CurrentIcon />
        <span
          className="absolute bottom-[3px] right-[3px]"
          style={{ color: active ? ACCENT : "rgba(255,255,255,0.35)" }}
        >
          <svg width="7" height="7" viewBox="0 0 8 8" fill="currentColor">
            <path d="M7 1v6H1z" />
          </svg>
        </span>
      </BarButton>
      {open && !disabled ? (
        <PopupCard popupRef={popupRef} style={style}>
          <div className="flex items-center gap-1">
            {SHAPE_KINDS.map((kind) => {
              const KindIcon = kind.icon;
              const selected = current === kind.id;
              return (
                <button
                  key={kind.id}
                  type="button"
                  title={`${kind.label} (${kind.key})`}
                  onClick={() => {
                    onToolChange(kind.id);
                    close();
                  }}
                  className="flex h-9 w-9 items-center justify-center rounded-xl transition-colors duration-100 cursor-pointer"
                  style={
                    selected
                      ? { backgroundColor: "rgba(249,95,74,0.16)", color: ACCENT }
                      : { color: ICON_IDLE }
                  }
                >
                  <KindIcon />
                </button>
              );
            })}
          </div>
        </PopupCard>
      ) : null}
    </div>
  );
}

function ColorSlot({
  settings,
  onSettingsChange,
  disabled,
}: {
  settings: ToolSettings;
  onSettingsChange: (next: ToolSettings) => void;
  disabled: boolean;
}) {
  const { open, style, triggerRef, popupRef, toggle, close } = usePopover();
  const [hexInput, setHexInput] = useState(settings.strokeColor.replace("#", ""));
  const [hexError, setHexError] = useState(false);

  useEffect(() => {
    setHexInput(settings.strokeColor.replace("#", ""));
    setHexError(false);
  }, [settings.strokeColor]);

  const applyColor = useCallback(
    (nextColor: string) => {
      onSettingsChange({
        ...settings,
        strokeColor: nextColor,
        textColor: nextColor,
        // When shapes are filled, the fill follows the stroke color
        fillColor: settings.fillColor === "transparent" ? "transparent" : nextColor,
      });
    },
    [settings, onSettingsChange]
  );

  const handleHexCommit = (raw: string) => {
    const normalized = normalizeHex(raw);
    if (normalized) {
      setHexError(false);
      applyColor(normalized);
    } else {
      setHexError(true);
    }
  };

  const currentColor = settings.strokeColor;

  return (
    <div className="relative flex shrink-0 items-center">
      <BarButton
        label="Color"
        disabled={disabled}
        buttonRef={triggerRef}
        onClick={toggle}
        active={open}
      >
        <span
          className="rounded-full"
          style={{
            width: 18,
            height: 18,
            backgroundColor: currentColor,
            boxShadow: "0 0 0 1.5px rgba(255,255,255,0.18)",
          }}
        />
      </BarButton>
      {open && !disabled ? (
        <PopupCard popupRef={popupRef} style={style} width={236}>
          <div className="mb-2.5 flex flex-wrap gap-1">
            {TOOL_COLORS.map((swatch) => {
              const isSelected = swatch.toLowerCase() === currentColor.toLowerCase();
              const bright = perceivedBrightness(swatch) > 140;
              return (
                <button
                  key={swatch}
                  type="button"
                  title={swatch}
                  onClick={() => {
                    applyColor(swatch);
                    close();
                  }}
                  className="relative flex items-center justify-center rounded-md transition-transform duration-100 hover:scale-110 active:scale-95 cursor-pointer"
                  style={{
                    width: 22,
                    height: 22,
                    backgroundColor: swatch,
                    outline: isSelected ? `2px solid ${ACCENT}` : "2px solid transparent",
                    outlineOffset: isSelected ? 1 : 0,
                  }}
                >
                  {isSelected ? (
                    <svg
                      width="9"
                      height="9"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke={bright ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.9)"}
                      strokeWidth="3.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : null}
                </button>
              );
            })}
          </div>
          <div className="mb-2.5 h-px" style={{ backgroundColor: "rgba(255,255,255,0.06)" }} />
          <div className="flex items-center gap-2">
            <div
              className="shrink-0 rounded-md border border-white/10"
              style={{ width: 22, height: 22, backgroundColor: currentColor }}
            />
            <div className="relative flex flex-1 items-center">
              <span
                className="pointer-events-none absolute left-2.5 select-none font-mono text-[11px]"
                style={{ color: "rgba(255,255,255,0.25)" }}
              >
                #
              </span>
              <input
                type="text"
                maxLength={6}
                value={hexInput}
                onChange={(e) => setHexInput(e.target.value)}
                onBlur={(e) => handleHexCommit(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") handleHexCommit((e.target as HTMLInputElement).value);
                }}
                spellCheck={false}
                className="w-full rounded-md py-1.5 pl-6 pr-2 font-mono text-[11px] outline-none"
                style={{
                  backgroundColor: hexError ? "rgba(239,68,68,0.12)" : "rgba(255,255,255,0.06)",
                  border: hexError
                    ? "1px solid rgba(239,68,68,0.4)"
                    : `1px solid ${HAIRLINE}`,
                  color: hexError ? "#fca5a5" : "#e3e3e8",
                }}
              />
            </div>
          </div>
        </PopupCard>
      ) : null}
    </div>
  );
}

function WidthSlot({
  settings,
  onSettingsChange,
  disabled,
}: {
  settings: ToolSettings;
  onSettingsChange: (next: ToolSettings) => void;
  disabled: boolean;
}) {
  const { open, style, triggerRef, popupRef, toggle, close } = usePopover();

  return (
    <div className="relative flex shrink-0 items-center">
      <BarButton
        label="Stroke width ([ and ])"
        disabled={disabled}
        buttonRef={triggerRef}
        onClick={toggle}
        active={open}
      >
        <svg width="16" height="16" viewBox="0 0 16 16">
          <line
            x1="2"
            y1="8"
            x2="14"
            y2="8"
            stroke="currentColor"
            strokeWidth={Math.min(settings.strokeWidth, 8)}
            strokeLinecap="round"
          />
        </svg>
      </BarButton>
      {open && !disabled ? (
        <PopupCard popupRef={popupRef} style={style}>
          <div className="flex items-end gap-1">
            {STROKE_WIDTHS.map((size) => {
              const isSelected = settings.strokeWidth === size;
              return (
                <button
                  key={size}
                  type="button"
                  title={`${size}px`}
                  onClick={() => {
                    onSettingsChange({ ...settings, strokeWidth: size });
                    close();
                  }}
                  className="flex flex-col items-center justify-end gap-1.5 rounded-xl px-2 py-2 transition-colors duration-100 cursor-pointer"
                  style={{
                    minWidth: 40,
                    backgroundColor: isSelected ? "rgba(249,95,74,0.14)" : "rgba(255,255,255,0.04)",
                    border: isSelected
                      ? "1px solid rgba(249,95,74,0.4)"
                      : "1px solid rgba(255,255,255,0.06)",
                  }}
                >
                  <span
                    className="w-6 rounded-full"
                    style={{
                      height: size,
                      backgroundColor: isSelected ? ACCENT : "rgba(255,255,255,0.35)",
                    }}
                  />
                  <span
                    className="font-mono text-[9px]"
                    style={{ color: isSelected ? ACCENT : "rgba(255,255,255,0.3)" }}
                  >
                    {size}
                  </span>
                </button>
              );
            })}
          </div>
        </PopupCard>
      ) : null}
    </div>
  );
}

export function WhiteboardToolbar({
  tool,
  onToolChange,
  settings,
  onSettingsChange,
  locked,
  onExport,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}: {
  tool: ToolKind;
  onToolChange: (tool: ToolKind) => void;
  settings: ToolSettings;
  onSettingsChange: (next: ToolSettings) => void;
  locked: boolean;
  onExport: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}) {
  // The laser only touches awareness, so viewers on a locked board can still point
  const editDisabled = locked;

  return (
    <div
      className="flex items-center gap-0.5 rounded-full px-2 py-1.5 backdrop-blur-md"
      style={{
        backgroundColor: BAR_BG,
        border: `1px solid ${HAIRLINE}`,
        boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
      }}
    >
      <BarButton label="Select (1)" active={tool === "select"} onClick={() => onToolChange("select")}>
        <SelectIcon />
      </BarButton>
      <BarButton label="Pan (H)" active={tool === "pan"} onClick={() => onToolChange("pan")}>
        <PanIcon />
      </BarButton>

      <BarDivider />

      <BarButton
        label="Pen (2)"
        active={tool === "pen"}
        disabled={editDisabled}
        onClick={() => onToolChange("pen")}
      >
        <PenIcon />
      </BarButton>
      <BarButton
        label="Highlighter (3)"
        active={tool === "highlighter"}
        disabled={editDisabled}
        onClick={() => onToolChange("highlighter")}
      >
        <HighlighterIcon />
      </BarButton>
      <BarButton
        label="Eraser (4)"
        active={tool === "eraser"}
        disabled={editDisabled}
        onClick={() => onToolChange("eraser")}
      >
        <EraserIcon />
      </BarButton>

      <BarDivider />

      <ShapeSlot tool={tool} onToolChange={onToolChange} disabled={editDisabled} />
      <BarButton
        label="Text (8)"
        active={tool === "text"}
        disabled={editDisabled}
        onClick={() => onToolChange("text")}
      >
        <TextIcon />
      </BarButton>
      <BarButton
        label="Sticky note (9)"
        active={tool === "sticky"}
        disabled={editDisabled}
        onClick={() => onToolChange("sticky")}
      >
        <StickyIcon />
      </BarButton>
      <BarButton label="Laser pointer (L)" active={tool === "laser"} onClick={() => onToolChange("laser")}>
        <LaserIcon />
      </BarButton>

      <BarDivider />

      <ColorSlot settings={settings} onSettingsChange={onSettingsChange} disabled={editDisabled} />
      <WidthSlot settings={settings} onSettingsChange={onSettingsChange} disabled={editDisabled} />

      <BarDivider />

      <BarButton label="Undo (Cmd+Z)" disabled={editDisabled || !canUndo} onClick={onUndo}>
        <UndoIcon />
      </BarButton>
      <BarButton label="Redo (Shift+Cmd+Z)" disabled={editDisabled || !canRedo} onClick={onRedo}>
        <RedoIcon />
      </BarButton>

      <BarDivider />

      <BarButton label="Export as PNG" onClick={onExport}>
        <ExportIcon />
      </BarButton>
    </div>
  );
}

/**
 * Contextual settings under the main bar: sticky colors when the sticky tool is
 * active, a fill toggle when a fillable shape is active. Nothing otherwise.
 */
export function WhiteboardContextBar({
  tool,
  settings,
  onSettingsChange,
  locked,
}: {
  tool: ToolKind;
  settings: ToolSettings;
  onSettingsChange: (next: ToolSettings) => void;
  locked: boolean;
}) {
  if (locked) return null;

  if (tool === "sticky") {
    return (
      <div
        className="flex items-center gap-1.5 rounded-full px-3 py-2 backdrop-blur-md"
        style={{
          backgroundColor: BAR_BG,
          border: `1px solid ${HAIRLINE}`,
          boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        }}
      >
        {STICKY_COLORS.map((swatch) => {
          const isSelected = swatch.toLowerCase() === settings.stickyColor.toLowerCase();
          return (
            <button
              key={swatch}
              type="button"
              title={swatch}
              onClick={() => onSettingsChange({ ...settings, stickyColor: swatch })}
              className="rounded-full transition-transform duration-100 hover:scale-110 active:scale-95 cursor-pointer"
              style={{
                width: 20,
                height: 20,
                backgroundColor: swatch,
                outline: isSelected ? `2px solid ${ACCENT}` : "2px solid transparent",
                outlineOffset: 1.5,
              }}
            />
          );
        })}
      </div>
    );
  }

  if (tool === "rect" || tool === "ellipse") {
    const filled = settings.fillColor !== "transparent";
    return (
      <div
        className="flex items-center gap-1 rounded-full p-1 backdrop-blur-md"
        style={{
          backgroundColor: BAR_BG,
          border: `1px solid ${HAIRLINE}`,
          boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        }}
      >
        {[
          { id: "outline", label: "Outline", isFilled: false },
          { id: "filled", label: "Filled", isFilled: true },
        ].map((option) => {
          const selected = filled === option.isFilled;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() =>
                onSettingsChange({
                  ...settings,
                  fillColor: option.isFilled ? settings.strokeColor : "transparent",
                })
              }
              className="rounded-full px-3 py-1 text-[11px] font-medium transition-colors duration-100 cursor-pointer"
              style={
                selected
                  ? { backgroundColor: "rgba(249,95,74,0.16)", color: ACCENT }
                  : { color: "rgba(255,255,255,0.55)" }
              }
            >
              {option.label}
            </button>
          );
        })}
      </div>
    );
  }

  return null;
}
