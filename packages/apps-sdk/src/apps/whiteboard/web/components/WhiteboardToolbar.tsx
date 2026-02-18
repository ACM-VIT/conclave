import React, { useState, useRef, useEffect, useCallback } from "react";
import type { ToolKind, ToolSettings } from "../../core/tools/engine";
import { TOOL_COLORS } from "../../shared/constants/tools";

const Icon = ({ children, size = 20 }: { children: React.ReactNode; size?: number }) => (
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
  <Icon size={16}>
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </Icon>
);

const TOOL_ICONS: Record<ToolKind, React.FC> = {
  select: SelectIcon,
  pen: PenIcon,
  highlighter: HighlighterIcon,
  eraser: EraserIcon,
  rect: RectIcon,
  ellipse: EllipseIcon,
  line: LineIcon,
  text: TextIcon,
  sticky: StickyIcon,
};

const TOOL_KEYS: Record<ToolKind, string> = {
  select: "1",
  pen: "2",
  highlighter: "3",
  eraser: "4",
  rect: "5",
  ellipse: "6",
  line: "7",
  text: "8",
  sticky: "9",
};

const TOOL_ORDER: ToolKind[] = [
  "select",
  "pen",
  "highlighter",
  "eraser",
  "rect",
  "ellipse",
  "line",
  "text",
  "sticky",
];

const STROKE_WIDTHS = [2, 3, 5, 8, 12];

/* ── Floating Island Container ── */

function Island({
  children,
  className = "",
  padding = 1,
}: {
  children: React.ReactNode;
  className?: string;
  padding?: number;
}) {
  return (
    <div
      className={`relative rounded-lg bg-[#232329] ${className}`}
      style={{
        padding: `${padding * 4}px`,
        boxShadow:
          "0px 0px 0.93px 0px rgba(0,0,0,0.25), 0px 0px 3.13px 0px rgba(0,0,0,0.16), 0px 7px 14px 0px rgba(0,0,0,0.12)",
      }}
    >
      {children}
    </div>
  );
}

function ToolDivider() {
  return <div className="w-px h-10 mt-0.5 mx-0.5 bg-white/10" />;
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
  const buttonStyle: React.CSSProperties = active
    ? {
        backgroundColor: "rgba(254, 252, 217, 0.12)",
        border: "1px solid rgba(254, 252, 217, 0.38)",
        color: "#FEFCD9",
      }
    : {
        backgroundColor: "transparent",
        border: "1px solid transparent",
        color: "rgba(254, 252, 217, 0.7)",
      };

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      title={`${toolId.charAt(0).toUpperCase() + toolId.slice(1)} (${keyHint})`}
      className={`
        group flex w-9 flex-col items-center gap-0.5 rounded-md transition-all duration-150 ease-in-out
        ${disabled ? "opacity-30 cursor-not-allowed" : "cursor-pointer"}
      `}
    >
      <span
        className={`relative flex h-9 w-9 items-center justify-center rounded-lg transition-all duration-150 ${
          active ? "" : "group-hover:bg-white/5"
        }`}
        style={buttonStyle}
      >
        <IconComponent />
      </span>
      <span
        className="select-none"
        style={{
          color: active ? "rgba(254,252,217,0.36)" : "rgba(254,252,217,0.18)",
          fontSize: 7,
          lineHeight: "7px",
          fontWeight: 400,
          letterSpacing: "0.02em",
          fontFamily: "'PolySans Mono', monospace",
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!disabled) {
            onClick();
          }
        }}
      >
        {/* {keyHint} */}
      </span>
    </button>
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
  const ref = useRef<HTMLDivElement>(null);

  const handleClickOutside = useCallback(
    (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    },
    []
  );

  useEffect(() => {
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open, handleClickOutside]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={locked}
        onClick={() => setOpen(!open)}
        className={`
          flex items-center justify-center w-9 h-9 rounded-lg transition-all duration-150
          hover:bg-[#2e2d39]
          ${locked ? "opacity-30 cursor-not-allowed" : "cursor-pointer"}
        `}
      >
        <div
          className="w-5 h-5 rounded-md border border-white/20 shadow-inner"
          style={{ backgroundColor: settings.strokeColor }}
        />
      </button>

      {open && !locked && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 z-50">
          <Island padding={2}>
            <div className="flex flex-col gap-3">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-[#b8b8b8] mb-2 px-0.5">
                  Stroke color
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {TOOL_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => {
                        onSettingsChange({ ...settings, strokeColor: color, textColor: color });
                      }}
                      className={`
                        w-7 h-7 rounded-md transition-all duration-100
                        ${
                          settings.strokeColor === color
                            ? "ring-2 ring-[#a8a5ff] ring-offset-1 ring-offset-[#232329] scale-110"
                            : "hover:scale-110"
                        }
                      `}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>

              <div>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-[#b8b8b8] mb-2 px-0.5">
                  Stroke width
                </div>
                <div className="flex items-center gap-1">
                  {STROKE_WIDTHS.map((size) => (
                    <button
                      key={size}
                      type="button"
                      onClick={() => onSettingsChange({ ...settings, strokeWidth: size })}
                      className={`
                        w-8 h-8 rounded-md flex items-center justify-center transition-all duration-100
                        ${
                          settings.strokeWidth === size
                            ? "bg-[#403e6a] shadow-[inset_0_0_0_1px_rgba(169,165,255,0.4)]"
                            : "hover:bg-[#2e2d39]"
                        }
                      `}
                    >
                      <span
                        className="rounded-full bg-[#e3e3e8]"
                        style={{
                          width: Math.max(3, size + 1),
                          height: Math.max(3, size + 1),
                        }}
                      />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </Island>
        </div>
      )}
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
  const pointerTools: ToolKind[] = ["select"];
  const drawTools: ToolKind[] = ["pen", "highlighter", "eraser"];
  const shapeTools: ToolKind[] = ["rect", "ellipse", "line"];
  const insertTools: ToolKind[] = ["text", "sticky"];

  return (
    <Island padding={1}>
      <div className="flex items-start gap-0.5">
        {pointerTools.map((id) => (
          <ToolButton
            key={id}
            toolId={id}
            active={tool === id}
            disabled={locked && id !== "select"}
            onClick={() => onToolChange(id)}
          />
        ))}

        <ToolDivider />

        {drawTools.map((id) => (
          <ToolButton
            key={id}
            toolId={id}
            active={tool === id}
            disabled={locked && id !== "select"}
            onClick={() => onToolChange(id)}
          />
        ))}

        <ToolDivider />

        {shapeTools.map((id) => (
          <ToolButton
            key={id}
            toolId={id}
            active={tool === id}
            disabled={locked && id !== "select"}
            onClick={() => onToolChange(id)}
          />
        ))}

        <ToolDivider />

        {insertTools.map((id) => (
          <ToolButton
            key={id}
            toolId={id}
            active={tool === id}
            disabled={locked && id !== "select"}
            onClick={() => onToolChange(id)}
          />
        ))}

        <ToolDivider />

        <ColorPicker
          settings={settings}
          onSettingsChange={onSettingsChange}
          locked={locked}
        />

        <ToolDivider />

        <button
          type="button"
          onClick={onExport}
          title="Export as PNG"
          className="flex items-center justify-center w-9 h-9 rounded-lg text-[#b8b8b8] hover:bg-[#2e2d39] hover:text-[#e3e3e8] transition-all duration-150 cursor-pointer"
        >
          <ExportIcon />
        </button>
      </div>
    </Island>
  );
}
