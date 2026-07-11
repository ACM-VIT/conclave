import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { WheelEntry, WheelSpin } from "../../core/doc/index";
import { WHEEL_LABEL_INK, segmentColor } from "../palette";
import type { WheelSounds } from "../sounds";

const WHEEL_RADIUS = 96;
const LABEL_RADIUS = 87;
const HUB_RADIUS = 24;
const FLAPPER_PIVOT_Y = -102;
const IDLE_DEG_PER_SEC = 3.6;
// Critically-damped-ish spring for the flapper (per-second units).
const FLAPPER_STIFFNESS = 640;
const FLAPPER_DAMPING = 16;
// Anticipation: the wheel coils back before it launches.
const PULLBACK_DEG = 8;
const PULLBACK_MS = 170;
// A skewed clock may claim the spin is nearly over the moment it arrives;
// guarantee at least this much visible motion instead of a teleport.
const MIN_VISIBLE_TAIL_MS = 1500;

export type WheelStageProps = {
  entries: WheelEntry[];
  spin: WheelSpin | null;
  canSpin: boolean;
  sounds: WheelSounds | null;
  reducedMotion: boolean;
  /** Winner segment to flash during the reveal beat (index into spin entries). */
  highlightIndex: number | null;
  onRequestSpin: () => void;
  /** fresh=false means the settle was replayed from history (late join). */
  onSettled: (spin: WheelSpin, fresh: boolean) => void;
  onSpinningChange: (spinning: boolean) => void;
};

type ActiveAnimation = {
  spin: WheelSpin;
  anchor: number;
  startDeg: number;
  delta: number;
  launched: boolean;
};

const mod360 = (value: number): number => ((value % 360) + 360) % 360;

const polar = (angleDeg: number, radius: number): readonly [number, number] => {
  const rad = (angleDeg * Math.PI) / 180;
  return [radius * Math.sin(rad), -radius * Math.cos(rad)] as const;
};

const segmentPath = (index: number, count: number): string => {
  const sweep = 360 / count;
  const a0 = sweep * index;
  const a1 = sweep * (index + 1);
  const [x0, y0] = polar(a0, WHEEL_RADIUS);
  const [x1, y1] = polar(a1, WHEEL_RADIUS);
  const largeArc = sweep > 180 ? 1 : 0;
  return `M 0 0 L ${x0} ${y0} A ${WHEEL_RADIUS} ${WHEEL_RADIUS} 0 ${largeArc} 1 ${x1} ${y1} Z`;
};

/** Wheel-local resting angle that puts the winning segment under the pointer. */
const restingAngle = (spin: WheelSpin): number => {
  const sweep = 360 / spin.entries.length;
  return mod360(-(spin.winnerIndex + spin.jitter) * sweep);
};

/**
 * Piecewise rotation curve: a short elastic pull-back, then a hard launch
 * with a very long deceleration crawl. Returns rotation as a fraction of the
 * forward travel (0 at start, 1 settled; briefly negative while coiling).
 */
const spinCurve = (elapsedMs: number, durationMs: number, travelDeg: number): number => {
  if (elapsedMs <= 0) return 0;
  if (elapsedMs >= durationMs) return 1;
  const pullbackFraction = PULLBACK_DEG / travelDeg;
  if (elapsedMs < PULLBACK_MS) {
    const p = elapsedMs / PULLBACK_MS;
    const eased = 1 - Math.pow(1 - p, 3);
    return -pullbackFraction * eased;
  }
  const p = (elapsedMs - PULLBACK_MS) / (durationMs - PULLBACK_MS);
  const eased = 1 - Math.pow(1 - p, 4);
  return -pullbackFraction + (1 + pullbackFraction) * eased;
};

const labelFontSize = (count: number): number => {
  if (count <= 4) return 12.5;
  if (count <= 8) return 11;
  if (count <= 12) return 9.5;
  if (count <= 20) return 8;
  if (count <= 32) return 6.6;
  if (count <= 48) return 5.4;
  return 4.6;
};

const labelMaxChars = (count: number): number => {
  if (count <= 8) return 17;
  if (count <= 16) return 14;
  if (count <= 32) return 11;
  return 9;
};

const truncateLabel = (label: string, count: number): string => {
  const max = labelMaxChars(count);
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
};

// Phantom segments so an empty wheel still reads as a wheel.
const EMPTY_SEGMENT_COUNT = 8;
const EMPTY_SEGMENT_FILLS = ["#131316", "#0f0f11"];

export function WheelStage({
  entries,
  spin,
  canSpin,
  sounds,
  reducedMotion,
  highlightIndex,
  onRequestSpin,
  onSettled,
  onSpinningChange,
}: WheelStageProps) {
  const wheelGroupRef = useRef<SVGGElement | null>(null);
  const flapperGroupRef = useRef<SVGGElement | null>(null);

  const rotationRef = useRef(0);
  const animationRef = useRef<ActiveAnimation | null>(null);
  const settledSpinIdsRef = useRef<Set<string>>(new Set());
  const flapperRef = useRef({ angle: 0, velocity: 0 });
  const segmentCountRef = useRef(0);
  // Once a spin has landed, the wheel must hold its pose (idle drift would
  // walk the pointer off the winner during the reveal and afterwards).
  const restingRef = useRef(false);

  const [displayedSpin, setDisplayedSpin] = useState<WheelSpin | null>(null);
  const [hubHover, setHubHover] = useState(false);
  const [hubFocus, setHubFocus] = useState(false);

  const onSettledRef = useRef(onSettled);
  const onSpinningChangeRef = useRef(onSpinningChange);
  const soundsRef = useRef(sounds);
  const reducedMotionRef = useRef(reducedMotion);
  onSettledRef.current = onSettled;
  onSpinningChangeRef.current = onSpinningChange;
  soundsRef.current = sounds;
  reducedMotionRef.current = reducedMotion;

  const displayedEntries = displayedSpin ? displayedSpin.entries : entries;
  const count = displayedEntries.length;
  segmentCountRef.current = count;

  const applyTransforms = useCallback(() => {
    const wheel = wheelGroupRef.current;
    if (wheel) {
      wheel.setAttribute("transform", `rotate(${mod360(rotationRef.current)})`);
    }
    const flapper = flapperGroupRef.current;
    if (flapper) {
      flapper.setAttribute(
        "transform",
        `rotate(${flapperRef.current.angle} 0 ${FLAPPER_PIVOT_Y})`
      );
    }
  }, []);

  // React re-renders never touch the transform attribute (it is not a managed
  // prop), but re-apply after every render in case a node was recreated.
  useLayoutEffect(() => {
    applyTransforms();
  });

  // Adopt a shared spin record: animate it live, or jump straight to its
  // resting pose when we joined after the ceremony already happened.
  useEffect(() => {
    if (!spin) {
      animationRef.current = null;
      setDisplayedSpin(null);
      onSpinningChangeRef.current(false);
      return;
    }
    if (settledSpinIdsRef.current.has(spin.spinId)) return;

    const now = Date.now();
    let anchor = Math.min(spin.startedAt, now);
    if (now - anchor >= spin.durationMs) {
      settledSpinIdsRef.current.add(spin.spinId);
      rotationRef.current = restingAngle(spin);
      restingRef.current = true;
      animationRef.current = null;
      setDisplayedSpin(null);
      onSpinningChangeRef.current(false);
      applyTransforms();
      onSettledRef.current(spin, false);
      return;
    }
    if (now - anchor > spin.durationMs - MIN_VISIBLE_TAIL_MS) {
      anchor = now - (spin.durationMs - MIN_VISIBLE_TAIL_MS);
    }

    const startDeg = mod360(rotationRef.current);
    rotationRef.current = startDeg;
    restingRef.current = false;
    const travel = mod360(restingAngle(spin) - startDeg) + spin.turns * 360;
    animationRef.current = {
      spin,
      anchor,
      startDeg,
      delta: travel,
      launched: false,
    };
    setDisplayedSpin(spin);
    onSpinningChangeRef.current(true);
  }, [spin, applyTransforms]);

  // Single rAF loop drives rotation, idle drift, and flapper physics without
  // re-rendering React on every frame.
  useEffect(() => {
    let frameId: number;
    let lastFrameAt = performance.now();

    const frame = (frameAt: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (frameAt - lastFrameAt) / 1000));
      lastFrameAt = frameAt;

      const previousDeg = rotationRef.current;
      const animation = animationRef.current;

      if (animation) {
        const elapsed = Date.now() - animation.anchor;
        if (!animation.launched && elapsed >= PULLBACK_MS) {
          animation.launched = true;
          soundsRef.current?.launch();
        }
        const fraction = spinCurve(
          elapsed,
          animation.spin.durationMs,
          animation.delta
        );
        rotationRef.current = animation.startDeg + animation.delta * fraction;
        if (elapsed >= animation.spin.durationMs) {
          rotationRef.current = mod360(animation.startDeg + animation.delta);
          restingRef.current = true;
          settledSpinIdsRef.current.add(animation.spin.spinId);
          const settled = animation.spin;
          animationRef.current = null;
          setDisplayedSpin(null);
          onSpinningChangeRef.current(false);
          onSettledRef.current(settled, true);
        }
      } else if (!reducedMotionRef.current && !restingRef.current) {
        rotationRef.current += IDLE_DEG_PER_SEC * dt;
        if (rotationRef.current > 7200) {
          rotationRef.current = mod360(rotationRef.current);
        }
      }

      // Flapper: kick when a segment boundary sweeps past the pointer, then
      // spring back. Boundaries pass whenever the total rotation crosses a
      // multiple of the segment sweep (only while moving forward).
      const segments = segmentCountRef.current;
      const moved = rotationRef.current - previousDeg;
      if (segments > 1 && moved > 0) {
        const sweep = 360 / segments;
        const crossings =
          Math.floor(rotationRef.current / sweep) -
          Math.floor(previousDeg / sweep);
        if (crossings > 0) {
          const speed = moved / dt; // deg per second
          const intensity = Math.min(1, speed / 900);
          flapperRef.current.velocity = Math.max(
            flapperRef.current.velocity,
            220 + 560 * intensity
          );
          if (animationRef.current) {
            soundsRef.current?.tick(intensity);
          }
        }
      }

      const flapper = flapperRef.current;
      flapper.velocity +=
        (-FLAPPER_STIFFNESS * flapper.angle - FLAPPER_DAMPING * flapper.velocity) *
        dt;
      flapper.angle += flapper.velocity * dt;
      flapper.angle = Math.max(-22, Math.min(54, flapper.angle));

      applyTransforms();
      frameId = requestAnimationFrame(frame);
    };

    frameId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(frameId);
  }, [applyTransforms]);

  const isSpinning = displayedSpin !== null;
  const canSpinNow = canSpin && !isSpinning && entries.length >= 2;

  const handleSpin = useCallback(() => {
    if (!canSpinNow) return;
    onRequestSpin();
  }, [canSpinNow, onRequestSpin]);

  const handleHubKeyDown = useCallback(
    (event: React.KeyboardEvent<SVGGElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleSpin();
      }
    },
    [handleSpin]
  );

  const segments = useMemo(() => {
    if (count === 0) {
      return Array.from({ length: EMPTY_SEGMENT_COUNT }, (_, index) => (
        <path
          key={`empty-${index}`}
          d={segmentPath(index, EMPTY_SEGMENT_COUNT)}
          fill={EMPTY_SEGMENT_FILLS[index % 2]}
          stroke="#0b0b0b"
          strokeWidth={1}
        />
      ));
    }
    if (count === 1) {
      return (
        <circle
          r={WHEEL_RADIUS}
          fill={segmentColor(0, 1)}
          stroke="#0b0b0b"
          strokeWidth={1}
        />
      );
    }
    const sweep = 360 / count;
    return displayedEntries.map((entry, index) => {
      const highlighted = highlightIndex === index;
      // The reveal beat: the winning slice lifts out along its mid angle and
      // gets a bright edge while everything else stays put.
      const [dx, dy] = highlighted
        ? polar(sweep * (index + 0.5), 3.5)
        : ([0, 0] as const);
      return (
        <path
          key={entry.id}
          d={segmentPath(index, count)}
          fill={segmentColor(index, count)}
          stroke={highlighted ? "#fafafa" : "#0b0b0b"}
          strokeWidth={highlighted ? 1.75 : 1}
          transform={highlighted ? `translate(${dx} ${dy})` : undefined}
          opacity={
            highlightIndex !== null && !highlighted ? 0.45 : 1
          }
          style={{ transition: "opacity 200ms linear" }}
        />
      );
    });
  }, [displayedEntries, count, highlightIndex]);

  const labels = useMemo(() => {
    if (count === 0) return null;
    if (count === 1) {
      const entry = displayedEntries[0];
      return (
        <text
          x={0}
          y={-((HUB_RADIUS + WHEEL_RADIUS) / 2)}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={12.5}
          fontWeight={600}
          fill={WHEEL_LABEL_INK}
        >
          {truncateLabel(entry.label, 1)}
        </text>
      );
    }
    const sweep = 360 / count;
    const fontSize = labelFontSize(count);
    return displayedEntries.map((entry, index) => {
      const mid = sweep * (index + 0.5);
      const [x, y] = polar(mid, LABEL_RADIUS);
      const dimmed = highlightIndex !== null && highlightIndex !== index;
      return (
        <text
          key={entry.id}
          x={x}
          y={y}
          transform={`rotate(${mid - 90} ${x} ${y})`}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize={fontSize}
          fontWeight={600}
          fill={WHEEL_LABEL_INK}
          opacity={dimmed ? 0.4 : 1}
        >
          {truncateLabel(entry.label, count)}
        </text>
      );
    });
  }, [displayedEntries, count, highlightIndex]);

  const hubActive = canSpinNow && (hubHover || hubFocus);
  const hubFill = isSpinning
    ? "#131316"
    : canSpinNow
      ? hubActive
        ? "#ff7059"
        : "#f95f4a"
      : "#131316";
  const hubStroke = isSpinning
    ? "rgba(249, 95, 74, 0.5)"
    : canSpinNow
      ? "rgba(255, 255, 255, 0.22)"
      : "rgba(255, 255, 255, 0.14)";
  const hubTextFill = canSpinNow || isSpinning ? "#ffffff" : "rgba(250, 250, 250, 0.3)";

  return (
    <div className="flex h-full w-full items-center justify-center p-4">
      <svg
        viewBox="-114 -120 228 234"
        className="h-full max-h-full w-full max-w-full"
        style={{ aspectRatio: "1 / 1" }}
        role="img"
        aria-label={
          count === 0
            ? "Empty wheel. Add names to spin."
            : `Wheel with ${count} name${count === 1 ? "" : "s"}`
        }
      >
        {/* Rim: a solid outer ring plus a hairline inset */}
        <circle
          r={WHEEL_RADIUS + 5}
          fill="none"
          stroke="rgba(255, 255, 255, 0.12)"
          strokeWidth={3}
        />
        <circle
          r={WHEEL_RADIUS + 1.5}
          fill="none"
          stroke="rgba(255, 255, 255, 0.05)"
          strokeWidth={1}
        />

        {/* Rotating wheel */}
        <g ref={wheelGroupRef}>
          {segments}
          {labels}
        </g>

        {/* Hub / spin button */}
        <g
          role="button"
          aria-label={canSpinNow ? "Spin the wheel" : "Spin unavailable"}
          aria-disabled={!canSpinNow}
          tabIndex={canSpinNow ? 0 : -1}
          className={canSpinNow ? "cursor-pointer" : undefined}
          onClick={handleSpin}
          onKeyDown={handleHubKeyDown}
          onMouseEnter={() => setHubHover(true)}
          onMouseLeave={() => setHubHover(false)}
          onFocus={() => setHubFocus(true)}
          onBlur={() => setHubFocus(false)}
          style={{
            transform: hubActive ? "scale(1.05)" : "scale(1)",
            transition: "transform 120ms ease-out",
            transformBox: "fill-box",
            transformOrigin: "center",
            // The hub draws its own focus affordance (coral ring); the UA's
            // default focus box around the bounding rect reads as a glitch.
            outline: "none",
          }}
        >
          {/* Dark seat ring keeps the hub crisp on any segment color. */}
          <circle r={HUB_RADIUS + 3} fill="#0b0b0b" />
          <circle
            r={HUB_RADIUS}
            fill={hubFill}
            stroke={hubStroke}
            strokeWidth={1.5}
            style={{ transition: "fill 150ms linear, stroke 150ms linear" }}
          />
          <text
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={7.5}
            fontWeight={700}
            letterSpacing={2}
            fill={hubTextFill}
            style={{ userSelect: "none" }}
          >
            {isSpinning ? "•••" : "SPIN"}
          </text>
        </g>

        {/* Flapper: kite-shaped pointer with a pivot pin */}
        <g ref={flapperGroupRef}>
          <path
            d={`M 0 ${FLAPPER_PIVOT_Y - 7}
                C 7 ${FLAPPER_PIVOT_Y - 7} 10 ${FLAPPER_PIVOT_Y - 2} 10 ${FLAPPER_PIVOT_Y + 1}
                C 10 ${FLAPPER_PIVOT_Y + 7} 4 ${FLAPPER_PIVOT_Y + 14} 0 ${FLAPPER_PIVOT_Y + 25}
                C -4 ${FLAPPER_PIVOT_Y + 14} -10 ${FLAPPER_PIVOT_Y + 7} -10 ${FLAPPER_PIVOT_Y + 1}
                C -10 ${FLAPPER_PIVOT_Y - 2} -7 ${FLAPPER_PIVOT_Y - 7} 0 ${FLAPPER_PIVOT_Y - 7}
                Z`}
            fill="#f95f4a"
            stroke="#0b0b0b"
            strokeWidth={1.5}
          />
          <circle
            cx={0}
            cy={FLAPPER_PIVOT_Y}
            r={3}
            fill="#0b0b0b"
            stroke="rgba(255, 255, 255, 0.4)"
            strokeWidth={1}
          />
        </g>
      </svg>
    </div>
  );
}
