import React, { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import type { ToolKind, ToolSettings } from "../../core/tools/engine";
import { TOOL_COLORS } from "../../shared/constants/tools";

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

const ExportIcon = () => (
  <Icon>
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </Icon>
);

const TOOL_ICONS: Record<ToolKind, React.FC> = {
  select: SelectIcon,
  pan: PanIcon,
  pen: PenIcon,
  highlighter: HighlighterIcon,
  eraser: EraserIcon,
  rect: RectIcon,
  ellipse: EllipseIcon,
  line: LineIcon,
  arrow: ArrowIcon,
  text: TextIcon,
  sticky: StickyIcon,
};

const TOOL_KEYS: Record<ToolKind, string> = {
  select: "1",
  pan: "H",
  pen: "2",
  highlighter: "3",
  eraser: "4",
  rect: "5",
  ellipse: "6",
  line: "7",
  arrow: "A",
  text: "8",
  sticky: "9",
};

const STROKE_WIDTHS = [2, 3, 5, 8, 12] as const;

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

const GAP = 8;

function calcPopupStyle(triggerRect: DOMRect): React.CSSProperties {
  return {
    position: "fixed",
    left: triggerRect.left + triggerRect.width / 2,
    top: triggerRect.bottom + GAP,
    transform: "translate(-50%, 0)",
    zIndex: 9999,
  };
}

function ToolButton({
  toolId,
  active,
  disabled,
  onClick,
}: {
  toolId: ToolKind;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const IconComponent = TOOL_ICONS[toolId];
  const keyHint = TOOL_KEYS[toolId];

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      title={`${toolId.charAt(0).toUpperCase() + toolId.slice(1)} (${keyHint})`}
      className={`relative flex h-8 w-8 items-center justify-center rounded-lg transition-all duration-100 ${
        disabled ? "opacity-25 cursor-not-allowed" : "cursor-pointer"
      }`}
      style={
        active
          ? {
              backgroundColor: "rgba(168,165,255,0.15)",
              border: "1px solid rgba(168,165,255,0.4)",
              color: "#c4c2ff",
            }
          : {
              backgroundColor: "transparent",
              border: "1px solid transparent",
              color: "rgba(255,255,255,0.45)",
            }
      }
    >
      <IconComponent />
      {active && (
        <span
          className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full"
          style={{ backgroundColor: "#a8a5ff" }}
        />
      )}
    </button>
  );
}

function ToolDivider() {
  return (
    <div
      className="w-px self-stretch my-1 mx-0.5"
      style={{ backgroundColor: "rgba(255,255,255,0.08)" }}
    />
  );
}

function ColorPicker({
  settings,
  onSettingsChange,
  locked,
}: {
  settings: ToolSettings;
  onSettingsChange: (next: ToolSettings) => void;
  locked: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties>({});
  const [hexInput, setHexInput] = useState(settings.strokeColor.replace("#", ""));
  const [hexError, setHexError] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHexInput(settings.strokeColor.replace("#", ""));
    setHexError(false);
  }, [settings.strokeColor]);

  const applyColor = useCallback(
    (color: string) => {
      onSettingsChange({ ...settings, strokeColor: color, textColor: color });
    },
    [settings, onSettingsChange]
  );

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    setPopupStyle(calcPopupStyle(trigger.getBoundingClientRect()));
  }, []);

  const handleOpen = useCallback(() => {
    if (locked) return;
    reposition();
    setOpen((prev) => !prev);
  }, [locked, reposition]);

  const handleClickOutside = useCallback((event: MouseEvent) => {
    const target = event.target as Node;
    if (
      popupRef.current &&
      !popupRef.current.contains(target) &&
      triggerRef.current &&
      !triggerRef.current.contains(target)
    ) {
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, handleClickOutside]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

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
  const bright = perceivedBrightness(currentColor.replace("#", "").padEnd(6, "0")) > 140;

  const popup = open && !locked ? (
    <div ref={popupRef} style={popupStyle}>
      <div
        className="rounded-xl p-2.5"
        style={{
          backgroundColor: "#1c1c22",
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4)",
          width: 236,
        }}
      >
        <div className="flex flex-wrap gap-1 mb-2.5">
          {TOOL_COLORS.map((color) => {
            const isSelected = color.toLowerCase() === currentColor.toLowerCase();
            const swatchBright = perceivedBrightness(color.replace("#", "").padEnd(6, "0")) > 140;
            return (
              <button
                key={color}
                type="button"
                title={color}
                onClick={() => {
                  applyColor(color);
                  setOpen(false);
                }}
                className="relative flex items-center justify-center rounded-md transition-all duration-100 hover:scale-110 active:scale-95 cursor-pointer"
                style={{
                  width: 22,
                  height: 22,
                  backgroundColor: color,
                  outline: isSelected
                    ? `2px solid ${swatchBright ? "rgba(0,0,0,0.5)" : "rgba(255,255,255,0.75)"}`
                    : "2px solid transparent",
                  outlineOffset: isSelected ? 1 : 0,
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.12), 0 1px 3px rgba(0,0,0,0.3)",
                }}
              >
                {isSelected && (
                  <svg
                    width="9"
                    height="9"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={swatchBright ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.9)"}
                    strokeWidth="3.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>

        <div className="h-px mb-2.5" style={{ backgroundColor: "rgba(255,255,255,0.06)" }} />

        <div className="flex items-center gap-2">
          <div
            className="rounded-md shrink-0 border border-white/10"
            style={{ width: 22, height: 22, backgroundColor: currentColor }}
          />
          <div className="relative flex-1 flex items-center">
            <span
              className="absolute left-2.5 text-[11px] font-mono pointer-events-none select-none"
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
              className="w-full rounded-md pl-6 pr-2 py-1.5 text-[11px] font-mono outline-none"
              style={{
                backgroundColor: hexError ? "rgba(239,68,68,0.12)" : "rgba(255,255,255,0.06)",
                border: hexError ? "1px solid rgba(239,68,68,0.4)" : "1px solid rgba(255,255,255,0.08)",
                color: hexError ? "#fca5a5" : "#e3e3e8",
              }}
            />
          </div>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className="relative flex items-center justify-center">
      <button
        ref={triggerRef}
        type="button"
        disabled={locked}
        onClick={handleOpen}
        title="Stroke color"
        className={`relative flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-100 ${
          locked ? "opacity-30 cursor-not-allowed" : "cursor-pointer"
        }`}
        style={
          open
            ? {
                backgroundColor: "rgba(168,165,255,0.12)",
                border: "1px solid rgba(168,165,255,0.35)",
              }
            : {
                border: "1px solid transparent",
              }
        }
      >
        <div
          className="rounded-full"
          style={{
            width: 20,
            height: 20,
            backgroundColor: currentColor,
            boxShadow: `0 0 0 1.5px rgba(255,255,255,0.15), 0 1px 4px rgba(0,0,0,0.4)`,
          }}
        />
      </button>

      {typeof document !== "undefined" ? createPortal(popup, document.body) : null}
    </div>
  );
}

function StrokeWidthPicker({
  settings,
  onSettingsChange,
  locked,
}: {
  settings: ToolSettings;
  onSettingsChange: (next: ToolSettings) => void;
  locked: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    setPopupStyle(calcPopupStyle(trigger.getBoundingClientRect()));
  }, []);

  const handleOpen = useCallback(() => {
    if (locked) return;
    reposition();
    setOpen((prev) => !prev);
  }, [locked, reposition]);

  const handleClickOutside = useCallback((event: MouseEvent) => {
    const target = event.target as Node;
    if (
      popupRef.current &&
      !popupRef.current.contains(target) &&
      triggerRef.current &&
      !triggerRef.current.contains(target)
    ) {
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, handleClickOutside]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const popup = open && !locked ? (
    <div ref={popupRef} style={popupStyle}>
      <div
        className="rounded-xl p-2"
        style={{
          backgroundColor: "#1c1c22",
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4)",
        }}
      >
        <p
          className="text-[9px] font-semibold uppercase tracking-widest mb-2 px-1"
          style={{ color: "rgba(255,255,255,0.28)" }}
        >
          Stroke width
        </p>
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
                  setOpen(false);
                }}
                className="flex flex-col items-center justify-end gap-1.5 rounded-lg px-2 py-2 transition-all duration-100 cursor-pointer"
                style={{
                  minWidth: 40,
                  backgroundColor: isSelected
                    ? "rgba(168,165,255,0.15)"
                    : "rgba(255,255,255,0.04)",
                  border: isSelected
                    ? "1px solid rgba(168,165,255,0.4)"
                    : "1px solid rgba(255,255,255,0.06)",
                }}
              >
                <div
                  className="rounded-full w-6"
                  style={{
                    height: size,
                    backgroundColor: isSelected
                      ? "#a8a5ff"
                      : "rgba(255,255,255,0.35)",
                  }}
                />
                <span
                  className="text-[9px] font-mono"
                  style={{
                    color: isSelected ? "#c4c2ff" : "rgba(255,255,255,0.3)",
                  }}
                >
                  {size}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className="relative flex items-center justify-center">
      <button
        ref={triggerRef}
        type="button"
        disabled={locked}
        onClick={handleOpen}
        title="Stroke width"
        className={`relative flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-100 ${
          locked ? "opacity-30 cursor-not-allowed" : "cursor-pointer"
        }`}
        style={
          open
            ? {
                backgroundColor: "rgba(168,165,255,0.12)",
                border: "1px solid rgba(168,165,255,0.35)",
                color: "#c4c2ff",
              }
            : {
                border: "1px solid transparent",
                color: "rgba(255,255,255,0.45)",
              }
        }
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
      </button>

      {typeof document !== "undefined" ? createPortal(popup, document.body) : null}
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
}: {
  tool: ToolKind;
  onToolChange: (tool: ToolKind) => void;
  settings: ToolSettings;
  onSettingsChange: (next: ToolSettings) => void;
  locked: boolean;
  onExport: () => void;
}) {
  const pointerTools: ToolKind[] = ["select", "pan"];
  const drawTools: ToolKind[] = ["pen", "highlighter", "eraser"];
  const shapeTools: ToolKind[] = ["rect", "ellipse", "line", "arrow"];
  const insertTools: ToolKind[] = ["text", "sticky"];

  return (
    <div
      className="flex items-center gap-0.5 rounded-xl px-1.5 py-1.5"
      style={{
        backgroundColor: "#1c1c22",
        border: "1px solid rgba(255,255,255,0.07)",
        boxShadow:
          "0 4px 6px -1px rgba(0,0,0,0.3), 0 10px 24px -4px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)",
      }}
    >
      {pointerTools.map((id) => (
        <ToolButton
          key={id}
          toolId={id}
          active={tool === id}
          disabled={locked && id !== "select" && id !== "pan"}
          onClick={() => onToolChange(id)}
        />
      ))}

      <ToolDivider />

      {drawTools.map((id) => (
        <ToolButton
          key={id}
          toolId={id}
          active={tool === id}
          disabled={locked && id !== "select" && id !== "pan"}
          onClick={() => onToolChange(id)}
        />
      ))}

      <ToolDivider />

      {shapeTools.map((id) => (
        <ToolButton
          key={id}
          toolId={id}
          active={tool === id}
          disabled={locked && id !== "select" && id !== "pan"}
          onClick={() => onToolChange(id)}
        />
      ))}

      <ToolDivider />

      {insertTools.map((id) => (
        <ToolButton
          key={id}
          toolId={id}
          active={tool === id}
          disabled={locked && id !== "select" && id !== "pan"}
          onClick={() => onToolChange(id)}
        />
      ))}

      <ToolDivider />

      <ColorPicker
        settings={settings}
        onSettingsChange={onSettingsChange}
        locked={locked}
      />
      <StrokeWidthPicker
        settings={settings}
        onSettingsChange={onSettingsChange}
        locked={locked}
      />

      <ToolDivider />

      <button
        type="button"
        onClick={onExport}
        title="Export as PNG"
        className="flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-100 cursor-pointer"
        style={{
          border: "1px solid transparent",
          color: "rgba(255,255,255,0.4)",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.backgroundColor = "rgba(255,255,255,0.05)";
          (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.8)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
          (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.4)";
        }}
      >
        <ExportIcon />
      </button>
    </div>
  );
}
