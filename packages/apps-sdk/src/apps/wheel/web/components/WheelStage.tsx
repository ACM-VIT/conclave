import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { WheelEntry, WheelSpin } from "../../core/doc/index";
import {
  HUB_RADIUS,
  LABEL_PAD,
  RIM_WIDTH,
  SINGLE_LABEL_SIZE,
  SINGLE_LABEL_Y,
  VIEW_EXTENT,
  VIEW_SIZE,
  WHEEL_RADIUS,
} from "../geometry";
import {
  fitSingleLabel,
  fitWheelLabels,
  isLabelFlipped,
  labelAngle,
  labelFlipSignature,
  uprightAngle,
  wheelLabelGeometry,
  type MeasureText,
} from "../labelFit";
import type { WheelSounds } from "../sounds";

const POINTER_ANGLE = 90;
const POINTER_BASE = WHEEL_RADIUS + RIM_WIDTH + 3;
const POINTER_TIP = WHEEL_RADIUS - 1.5;
const VIEWBOX = `${-VIEW_EXTENT} ${-VIEW_EXTENT} ${VIEW_SIZE} ${VIEW_SIZE}`;
const EMPTY_SEGMENT_COUNT = 8;

const IDLE_DEG_PER_SEC = 3.6;
const FLAPPER_STIFFNESS = 640;
const FLAPPER_DAMPING = 16;
const MIN_VISIBLE_TAIL_MS = 1500;
const REDUCED_TAIL_MS = 1100;

const PROFILE_STEPS = 600;
const WINDUP_MS = 150;
const PUSH_MS = 240;
const WINDUP_SPEED = 0.06;
const DECAY_POWER = 2.5;
const LABEL_FADE_FROM = 240;
const LABEL_FADE_SPAN = 700;

const HOLDING_STILL = Symbol("holding still");

const COLOR = {
  slices: ["#1F1F23", "#29292E"],
  oddSeam: "#242428",
  emptySlices: ["#1a1a1d", "#151518"],
  ink: "rgba(250, 250, 250, 0.88)",
  numberInk: "rgba(250, 250, 250, 0.4)",
  winner: "#F95F4A",
  winnerInk: "#0a0a0b",
  rim: "#18181b",
  rimEdge: "rgba(250, 250, 250, 0.14)",
  pointerEdge: "#0a0a0b",
} as const;

export type WheelStageProps = {
  entries: WheelEntry[];
  spin: WheelSpin | null;
  canSpin: boolean;
  sounds: WheelSounds | null;
  reducedMotion: boolean;
  highlightIndex: number | null;
  onRequestSpin: () => void;
  onSettled: (spin: WheelSpin, fresh: boolean) => void;
  onSpinningChange: (spinning: boolean) => void;
  onPointerLabel?: (label: string | null) => void;
};

type ActiveAnimation = {
  spin: WheelSpin;
  anchor: number;
  startDeg: number;
  restDeg: number;
  delta: number;
  flipAt: number;
  launched: boolean;
  reduced: boolean;
  profile: Float64Array;
};

const mod360 = (value: number): number => ((value % 360) + 360) % 360;

const polar = (angleDeg: number, radius: number): readonly [number, number] => {
  const rad = (angleDeg * Math.PI) / 180;
  return [radius * Math.sin(rad), -radius * Math.cos(rad)] as const;
};

const segmentPath = (index: number, count: number): string => {
  const sweep = 360 / count;
  const [x0, y0] = polar(sweep * index, WHEEL_RADIUS);
  const [x1, y1] = polar(sweep * (index + 1), WHEEL_RADIUS);
  const largeArc = sweep > 180 ? 1 : 0;
  return `M 0 0 L ${x0} ${y0} A ${WHEEL_RADIUS} ${WHEEL_RADIUS} 0 ${largeArc} 1 ${x1} ${y1} Z`;
};

const sliceFill = (index: number, count: number): string =>
  count > 1 && count % 2 === 1 && index === count - 1
    ? COLOR.oddSeam
    : COLOR.slices[index % 2];

const restingAngle = (spin: WheelSpin): number => {
  const sweep = 360 / spin.entries.length;
  return mod360(POINTER_ANGLE - (spin.winnerIndex + spin.jitter) * sweep);
};

const launchVelocity = (t: number, durationMs: number): number => {
  if (t < WINDUP_MS) return -WINDUP_SPEED * Math.sin((Math.PI * t) / WINDUP_MS);
  if (t < WINDUP_MS + PUSH_MS) {
    const s = (t - WINDUP_MS) / PUSH_MS;
    return s * s * (3 - 2 * s);
  }
  const coast = Math.max(1, durationMs - WINDUP_MS - PUSH_MS);
  const s = Math.min(1, (t - WINDUP_MS - PUSH_MS) / coast);
  return Math.pow(1 - s, DECAY_POWER);
};

const buildProfile = (durationMs: number): Float64Array => {
  const table = new Float64Array(PROFILE_STEPS + 1);
  const step = durationMs / PROFILE_STEPS;
  let travelled = 0;
  for (let i = 0; i < PROFILE_STEPS; i += 1) {
    travelled += launchVelocity((i + 0.5) * step, durationMs) * step;
    table[i + 1] = travelled;
  }
  for (let i = 0; i <= PROFILE_STEPS; i += 1) table[i] /= travelled;
  return table;
};

const spinFraction = (animation: ActiveAnimation, elapsedMs: number): number => {
  const duration = animation.spin.durationMs;
  if (elapsedMs >= duration) return 1;
  if (animation.reduced) {
    const p = Math.max(0, (elapsedMs - (duration - REDUCED_TAIL_MS)) / REDUCED_TAIL_MS);
    return 1 - Math.pow(1 - p, 3);
  }
  if (elapsedMs <= 0) return 0;
  const position = (elapsedMs / duration) * PROFILE_STEPS;
  const index = Math.floor(position);
  const t = position - index;
  const { profile } = animation;
  return profile[index] + (profile[index + 1] - profile[index]) * t;
};

const pointerIndex = (rotation: number, count: number): number =>
  Math.min(count - 1, Math.floor(mod360(POINTER_ANGLE - rotation) / (360 / count)));

const fallbackMeasure: MeasureText = (text) => Array.from(text).length * 0.56;

const canvasMeasure = (fontFamily: string): MeasureText => {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return fallbackMeasure;
  context.font = `600 100px ${fontFamily}`;
  return (text) => context.measureText(text).width / 100;
};

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
  onPointerLabel,
}: WheelStageProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wheelGroupRef = useRef<SVGGElement | null>(null);
  const labelGroupRef = useRef<SVGGElement | null>(null);
  const flapperGroupRef = useRef<SVGGElement | null>(null);

  const rotationRef = useRef(0);
  const animationRef = useRef<ActiveAnimation | null>(null);
  const settledSpinIdsRef = useRef<Set<string>>(new Set());
  const flapperRef = useRef({ angle: 0, velocity: 0 });
  const segmentCountRef = useRef(0);
  const restingRef = useRef(false);
  const speedRef = useRef(0);
  const flipKeyRef = useRef("");
  const pointerLabelRef = useRef<string | symbol | null>(null);

  const [displayedSpin, setDisplayedSpin] = useState<WheelSpin | null>(null);
  const [flipRotation, setFlipRotation] = useState(0);
  const [measure, setMeasure] = useState<MeasureText>(() => fallbackMeasure);
  const [wheelPx, setWheelPx] = useState(0);

  const onSettledRef = useRef(onSettled);
  const onSpinningChangeRef = useRef(onSpinningChange);
  const onPointerLabelRef = useRef(onPointerLabel);
  const soundsRef = useRef(sounds);
  const reducedMotionRef = useRef(reducedMotion);
  onSettledRef.current = onSettled;
  onSpinningChangeRef.current = onSpinningChange;
  onPointerLabelRef.current = onPointerLabel;
  soundsRef.current = sounds;
  reducedMotionRef.current = reducedMotion;

  const displayedEntries = displayedSpin ? displayedSpin.entries : entries;
  const count = displayedEntries.length;
  segmentCountRef.current = count;
  const displayedEntriesRef = useRef(displayedEntries);
  displayedEntriesRef.current = displayedEntries;

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const updateScale = () => {
      const box = svg.getBoundingClientRect();
      setWheelPx(Math.max(0, Math.min(box.width, box.height)));
    };
    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const family = window.getComputedStyle(svg).fontFamily || "sans-serif";
    setMeasure(() => canvasMeasure(family));
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) setMeasure(() => canvasMeasure(family));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyTransforms = useCallback(() => {
    const wheel = wheelGroupRef.current;
    if (wheel) {
      wheel.setAttribute("transform", `rotate(${mod360(rotationRef.current)})`);
    }
    const flapper = flapperGroupRef.current;
    if (flapper) {
      flapper.setAttribute(
        "transform",
        `rotate(${flapperRef.current.angle} 0 ${-POINTER_BASE})`
      );
    }
    const numbers = labelGroupRef.current?.querySelectorAll("[data-wheel-number]") ?? [];
    for (const number of numbers) {
      number.setAttribute(
        "transform",
        `rotate(${uprightAngle(rotationRef.current)} ${number.getAttribute("x")} ${number.getAttribute("y")})`
      );
    }
  }, []);

  useLayoutEffect(() => {
    applyTransforms();
  });

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
    const reduced = reducedMotionRef.current;
    const restDeg = restingAngle(spin);
    animationRef.current = {
      spin,
      anchor,
      startDeg,
      restDeg,
      delta: mod360(restDeg - startDeg) + (reduced ? 1 : spin.turns) * 360,
      flipAt: reduced ? spin.durationMs - REDUCED_TAIL_MS : WINDUP_MS + PUSH_MS,
      launched: false,
      reduced,
      profile: buildProfile(spin.durationMs),
    };
    setDisplayedSpin(spin);
    onSpinningChangeRef.current(true);
  }, [spin, applyTransforms]);

  useEffect(() => {
    let frameId: number;
    let lastFrameAt = performance.now();

    const frame = (frameAt: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (frameAt - lastFrameAt) / 1000));
      lastFrameAt = frameAt;
      const frameNow = Date.now();

      const previousDeg = rotationRef.current;
      const animation = animationRef.current;
      let flipReference = rotationRef.current;
      let unwrappedDeg = previousDeg;

      if (animation) {
        const elapsed = frameNow - animation.anchor;
        const launchAt = animation.reduced ? animation.flipAt : WINDUP_MS;
        if (!animation.launched && elapsed >= launchAt) {
          animation.launched = true;
          soundsRef.current?.launch();
        }
        unwrappedDeg =
          animation.startDeg + animation.delta * spinFraction(animation, elapsed);
        rotationRef.current = unwrappedDeg;
        flipReference = elapsed >= animation.flipAt ? animation.restDeg : animation.startDeg;
        if (elapsed >= animation.spin.durationMs) {
          rotationRef.current = animation.restDeg;
          flipReference = animation.restDeg;
          restingRef.current = true;
          settledSpinIdsRef.current.add(animation.spin.spinId);
          const settled = animation.spin;
          animationRef.current = null;
          setDisplayedSpin(null);
          onSpinningChangeRef.current(false);
          onSettledRef.current(settled, true);
        }
      } else if (!reducedMotionRef.current && !restingRef.current) {
        unwrappedDeg = previousDeg + IDLE_DEG_PER_SEC * dt;
        rotationRef.current =
          unwrappedDeg > 7200 ? mod360(unwrappedDeg) : unwrappedDeg;
        flipReference = rotationRef.current;
      }

      const segments = segmentCountRef.current;
      const moved = unwrappedDeg - previousDeg;

      if (segments > 0) {
        const reference = segments === 1 ? rotationRef.current : flipReference;
        const flipKey = labelFlipSignature(reference, segments);
        if (flipKey !== flipKeyRef.current) {
          flipKeyRef.current = flipKey;
          setFlipRotation(reference);
        }
      }

      speedRef.current += (Math.abs(moved) / dt - speedRef.current) * Math.min(1, dt * 12);
      const labelGroup = labelGroupRef.current;
      if (labelGroup) {
        const fade = Math.min(
          1,
          Math.max(0, (speedRef.current - LABEL_FADE_FROM) / LABEL_FADE_SPAN)
        );
        labelGroup.setAttribute("opacity", (1 - 0.78 * fade).toFixed(3));
      }

      if (onPointerLabelRef.current && segments > 0) {
        const holdingStill = Boolean(
          animation?.reduced && frameNow - animation.anchor < animation.flipAt
        );
        const index =
          !holdingStill && (animationRef.current || restingRef.current)
            ? pointerIndex(rotationRef.current, segments)
            : -1;
        const label =
          index >= 0 ? displayedEntriesRef.current[index]?.label ?? null : null;
        const key = holdingStill ? HOLDING_STILL : label;
        if (key !== pointerLabelRef.current) {
          pointerLabelRef.current = key;
          onPointerLabelRef.current(label);
        }
      }

      if (segments > 1 && moved > 0) {
        const sweep = 360 / segments;
        const crossings =
          Math.floor((unwrappedDeg - POINTER_ANGLE) / sweep) -
          Math.floor((previousDeg - POINTER_ANGLE) / sweep);
        if (crossings > 0) {
          const speed = moved / dt;
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
  const hasHighlight = highlightIndex !== null;

  const fitted = useMemo(() => {
    if (count < 2) return null;
    return fitWheelLabels(
      displayedEntries.map((entry) => entry.label),
      wheelLabelGeometry(count, wheelPx),
      measure
    );
  }, [count, displayedEntries, measure, wheelPx]);

  const segments = useMemo(() => {
    if (count === 0) {
      return Array.from({ length: EMPTY_SEGMENT_COUNT }, (_, index) => (
        <path
          key={`empty-${index}`}
          d={segmentPath(index, EMPTY_SEGMENT_COUNT)}
          fill={COLOR.emptySlices[index % 2]}
        />
      ));
    }
    if (count === 1) return <circle r={WHEEL_RADIUS} fill={COLOR.slices[0]} />;
    return displayedEntries.map((entry, index) => (
      <path
        key={entry.id}
        d={segmentPath(index, count)}
        fill={highlightIndex === index ? COLOR.winner : sliceFill(index, count)}
        style={{ transition: "fill 120ms linear" }}
      />
    ));
  }, [displayedEntries, count, highlightIndex]);

  const labels = useMemo(() => {
    if (count === 1) {
      const text = fitSingleLabel(displayedEntries[0].label, wheelPx, measure);
      return text ? (
        <text
          x={0}
          y={SINGLE_LABEL_Y}
          transform={
            isLabelFlipped(0, 1, flipRotation) ? `rotate(180 0 ${SINGLE_LABEL_Y})` : undefined
          }
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={SINGLE_LABEL_SIZE}
          fontWeight={600}
          fill={COLOR.ink}
        >
          {text}
        </text>
      ) : null;
    }
    if (!fitted) return null;
    const sweep = 360 / count;
    return displayedEntries.map((entry, index) => {
      const label = fitted.labels[index];
      if (!label) return null;
      const mid = sweep * (index + 0.5);
      const [x, y] = polar(mid, label.numbered ? label.radius : WHEEL_RADIUS - LABEL_PAD);
      const flipped = isLabelFlipped(index, count, flipRotation);
      const highlighted = highlightIndex === index;
      return (
        <text
          key={entry.id}
          x={x}
          y={y}
          data-wheel-number={label.numbered ? "" : undefined}
          transform={`rotate(${labelAngle(index, count, flipRotation, label.numbered)} ${x} ${y})`}
          textAnchor={label.numbered ? "middle" : flipped ? "start" : "end"}
          dominantBaseline="central"
          fontSize={fitted.fontSize}
          fontWeight={600}
          fill={highlighted ? COLOR.winnerInk : label.numbered ? COLOR.numberInk : COLOR.ink}
          opacity={hasHighlight && !highlighted ? 0.4 : 1}
          style={label.numbered ? { fontVariantNumeric: "tabular-nums" } : undefined}
        >
          {label.text}
        </text>
      );
    });
  }, [displayedEntries, count, fitted, flipRotation, highlightIndex, hasHighlight, measure, wheelPx]);

  return (
    <div className="flex h-full w-full items-center justify-center p-4">
      <svg
        ref={svgRef}
        viewBox={VIEWBOX}
        className="h-full max-h-full w-full max-w-full"
        style={{ aspectRatio: "1 / 1" }}
        role="img"
        aria-label={
          count === 0
            ? "Empty wheel"
            : `Wheel with ${count} name${count === 1 ? "" : "s"}`
        }
      >
        <circle
          r={WHEEL_RADIUS + RIM_WIDTH / 2}
          fill="none"
          stroke={COLOR.rim}
          strokeWidth={RIM_WIDTH}
        />
        <circle
          r={WHEEL_RADIUS + RIM_WIDTH}
          fill="none"
          stroke={COLOR.rimEdge}
          strokeWidth={0.75}
        />

        <g ref={wheelGroupRef}>
          {segments}
          <g ref={labelGroupRef}>{labels}</g>
        </g>

        <circle
          r={HUB_RADIUS}
          fill={COLOR.rim}
          stroke={COLOR.rimEdge}
          strokeWidth={0.75}
          className={canSpinNow ? "cursor-pointer" : undefined}
          onClick={canSpinNow ? onRequestSpin : undefined}
        />

        <g transform={`rotate(${POINTER_ANGLE})`}>
          <g ref={flapperGroupRef}>
            <path
              d={`M -6 ${-POINTER_BASE} L 6 ${-POINTER_BASE} L 1.1 ${-POINTER_TIP - 1.9} Q 0 ${-POINTER_TIP} -1.1 ${-POINTER_TIP - 1.9} Z`}
              fill={COLOR.winner}
              stroke={COLOR.pointerEdge}
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
          </g>
        </g>
      </svg>
    </div>
  );
}
