"use client";
import React from "react";
import { Facehash } from "facehash";
import { MicOff } from "lucide-react";
import { color } from "../tokens";

const FACEHASH_COLORS = [
  "#F95F4A", // coral
  "#FF007A", // pink
  "#7C5CFF", // violet
  "#2DA8A8", // teal
  "#4F86F7", // blue
  "#3FA66A", // green
  "#F59E0B", // amber
  "#14B8A6", // turquoise
  "#E879F9", // magenta
  "#38BDF8", // sky
  "#FF8A3D", // tangerine
  "#FB7185", // rose
  "#C084FC", // lavender
  "#6366F1", // indigo
  "#10B981", // emerald
  "#FF5EAE", // bubblegum
] as const;

/* ------------------------------------------------------------------ Avatar ---
 * Deterministic Facehash avatar. Seed includes the stable id when available. */
export interface AvatarProps {
  name: string;
  /** Stable id for face hashing (falls back to name). */
  id?: string;
  size?: number | string;
  className?: string;
}

export function Avatar({ name, id, size = 64, className = "" }: AvatarProps) {
  const trimmedName = name.trim();
  const faceName = trimmedName || id?.trim() || "?";
  const seed = id?.trim() ? `${faceName}:${id.trim()}` : faceName;
  const numericSize = typeof size === "number" ? size : 64;

  // Independent salted hashes so the mouth and 3D depth feel uncorrelated from
  // the eyes/color/tilt that Facehash derives from the same seed. This widens
  // the space of distinct, playful faces well beyond the base palette × eyes.
  const mouthVariant = avatarHash(`${seed}|mouth`) % MOUTH_SHAPES.length;
  const intensity3d = avatarHash(`${seed}|depth`) % 3 === 0 ? "medium" : "dramatic";

  return (
    <Facehash
      aria-label={`${faceName} avatar`}
      className={"inline-flex shrink-0 rounded-full text-white " + className}
      colors={[...FACEHASH_COLORS]}
      enableBlink={numericSize >= 40}
      intensity3d={intensity3d}
      name={seed}
      onRenderMouth={() => (
        <FacehashMouth size={numericSize} variant={mouthVariant} />
      )}
      role="img"
      showInitial={false}
      size={size}
      style={{
        borderRadius: "9999px",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.18)",
        fontFamily: "var(--font-display)",
        fontWeight: 700,
      }}
      variant="gradient"
    />
  );
}

function avatarHash(seed: string) {
  let hash = 0;
  for (let index = 0; index < seed.length; index++) {
    hash = (hash << 5) - hash + seed.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

/* A grab-bag of playful mouth expressions, rendered as crisp SVG so they scale
 * cleanly at any avatar size. `frac` is the mouth width as a fraction of the
 * avatar size; `vb` is the SVG viewBox the shape is drawn in. Tongue uses a soft
 * pink for a pop of contrast; everything else inherits the white face color. */
const TONGUE = "#FF8FB1";
const MOUTH_SHAPES: { vb: [number, number]; frac: number; el: React.ReactNode }[] = [
  // 0 · gentle smile
  {
    vb: [32, 14],
    frac: 0.32,
    el: <path d="M3 4 Q16 16 29 4" stroke="currentColor" strokeWidth={4} strokeLinecap="round" />,
  },
  // 1 · big open grin
  {
    vb: [34, 20],
    frac: 0.34,
    el: <path d="M4 5 Q17 8 30 5 Q28 19 17 19 Q6 19 4 5 Z" fill="currentColor" />,
  },
  // 2 · neutral
  {
    vb: [26, 8],
    frac: 0.24,
    el: <rect x={2} y={2} width={22} height={4} rx={2} fill="currentColor" />,
  },
  // 3 · frown
  {
    vb: [32, 14],
    frac: 0.3,
    el: <path d="M3 11 Q16 -1 29 11" stroke="currentColor" strokeWidth={4} strokeLinecap="round" />,
  },
  // 4 · surprised "oh"
  {
    vb: [16, 18],
    frac: 0.18,
    el: <ellipse cx={8} cy={9} rx={4.5} ry={5.5} fill="currentColor" />,
  },
  // 5 · cat / :3
  {
    vb: [32, 12],
    frac: 0.3,
    el: (
      <path
        d="M3 3 Q9 11 16 4 Q23 11 29 3"
        stroke="currentColor"
        strokeWidth={3.5}
        strokeLinecap="round"
      />
    ),
  },
  // 6 · wavy / unsure
  {
    vb: [32, 10],
    frac: 0.3,
    el: (
      <path
        d="M2 6 Q9 1 16 5 Q23 9 30 4"
        stroke="currentColor"
        strokeWidth={3.5}
        strokeLinecap="round"
      />
    ),
  },
  // 7 · smirk
  {
    vb: [30, 14],
    frac: 0.28,
    el: <path d="M3 10 Q15 13 27 4" stroke="currentColor" strokeWidth={4} strokeLinecap="round" />,
  },
  // 8 · cheeky tongue-out
  {
    vb: [32, 20],
    frac: 0.3,
    el: (
      <>
        <path d="M3 4 Q16 15 29 4" stroke="currentColor" strokeWidth={4} strokeLinecap="round" />
        <path d="M12 11 Q12 19 16 19 Q20 19 20 11 Z" fill={TONGUE} />
      </>
    ),
  },
  // 9 · tiny dot
  {
    vb: [8, 8],
    frac: 0.1,
    el: <circle cx={4} cy={4} r={3} fill="currentColor" />,
  },
];

function FacehashMouth({ size, variant }: { size: number; variant: number }) {
  const shape = MOUTH_SHAPES[variant % MOUTH_SHAPES.length];
  const [vbW, vbH] = shape.vb;
  const width = Math.max(6, Math.round(size * shape.frac));
  const height = Math.round((width * vbH) / vbW);

  return (
    <svg
      aria-hidden="true"
      width={width}
      height={height}
      viewBox={`0 0 ${vbW} ${vbH}`}
      fill="none"
      style={{ display: "block", overflow: "visible" }}
    >
      {shape.el}
    </svg>
  );
}

/* --------------------------------------------------------------- NamePlate ---
 * Bottom-left name pill on a tile. Sans (NEVER mono), flat dark surface. */
export interface NamePlateProps {
  name: string;
  isLocal?: boolean;
  isMuted?: boolean;
  className?: string;
}

export function NamePlate({ name, isLocal, isMuted, className = "" }: NamePlateProps) {
  return (
    <div
      className={
        "inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1.5 " + className
      }
      style={{ backgroundColor: color.scrim, border: `1px solid ${color.border}` }}
    >
      <span
        className="truncate text-[13px] font-medium"
        style={{ color: color.text, fontFamily: "var(--font-sans)" }}
      >
        {name}
      </span>
      {isLocal ? (
        <span className="text-[11px] font-medium" style={{ color: color.accent }}>
          You
        </span>
      ) : null}
      {isMuted ? <MicOff size={13} strokeWidth={2} style={{ color: color.accent }} /> : null}
    </div>
  );
}
