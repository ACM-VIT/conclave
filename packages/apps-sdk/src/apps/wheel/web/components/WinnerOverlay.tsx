import React, { useEffect, useRef } from "react";
import { WHEEL_SEGMENT_COLORS } from "../palette";

export type WinnerOverlayProps = {
  label: string;
  color: string;
  byName: string;
  /** 1-based position of this result in the running history. */
  resultNumber: number;
  canRemove: boolean;
  canSpinAgain: boolean;
  reducedMotion: boolean;
  onRemove: () => void;
  onSpinAgain: () => void;
  onClose: () => void;
};

type ConfettiParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rotation: number;
  rotationSpeed: number;
  color: string;
  bornAt: number;
  lifeMs: number;
};

const CONFETTI_GRAVITY = 620; // px/s^2
const CONFETTI_DRAG = 0.3;
const SECOND_WAVE_DELAY_MS = 320;

const spawnBurst = (
  particles: ConfettiParticle[],
  originX: number,
  originY: number,
  baseAngleDeg: number,
  spreadDeg: number,
  amount: number,
  now: number
) => {
  for (let i = 0; i < amount; i += 1) {
    const angle =
      ((baseAngleDeg + (Math.random() - 0.5) * spreadDeg) * Math.PI) / 180;
    const speed = 260 + Math.random() * 460;
    particles.push({
      x: originX,
      y: originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 5 + Math.random() * 5.5,
      rotation: Math.random() * Math.PI,
      rotationSpeed: (Math.random() - 0.5) * 15,
      color:
        WHEEL_SEGMENT_COLORS[
          Math.floor(Math.random() * WHEEL_SEGMENT_COLORS.length)
        ],
      bornAt: now,
      lifeMs: 1500 + Math.random() * 900,
    });
  }
};

function ConfettiCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const scale = Math.min(2, window.devicePixelRatio || 1);
    const width = parent.clientWidth;
    const height = parent.clientHeight;
    canvas.width = Math.max(1, Math.floor(width * scale));
    canvas.height = Math.max(1, Math.floor(height * scale));
    context.scale(scale, scale);

    const particles: ConfettiParticle[] = [];
    const startedAt = performance.now();
    // Center pop plus two corner cannons aimed inward, then a lighter
    // second wave so the celebration lingers a beat.
    spawnBurst(particles, width / 2, height * 0.32, -90, 140, 90, startedAt);
    spawnBurst(particles, width * 0.05, height * 0.95, -60, 42, 40, startedAt);
    spawnBurst(particles, width * 0.95, height * 0.95, -120, 42, 40, startedAt);
    let secondWaveDone = false;

    let frameId: number;
    let lastAt = startedAt;

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - lastAt) / 1000);
      lastAt = now;

      if (!secondWaveDone && now - startedAt >= SECOND_WAVE_DELAY_MS) {
        secondWaveDone = true;
        spawnBurst(particles, width * 0.3, height * 0.28, -90, 100, 30, now);
        spawnBurst(particles, width * 0.7, height * 0.28, -90, 100, 30, now);
      }

      context.clearRect(0, 0, width, height);

      let alive = 0;
      for (const particle of particles) {
        const age = now - particle.bornAt;
        if (age > particle.lifeMs) continue;
        alive += 1;

        particle.vy += CONFETTI_GRAVITY * dt;
        particle.vx -= particle.vx * CONFETTI_DRAG * dt;
        particle.x += particle.vx * dt;
        particle.y += particle.vy * dt;
        particle.rotation += particle.rotationSpeed * dt;

        const lifeLeft = 1 - age / particle.lifeMs;
        context.globalAlpha = Math.min(1, lifeLeft / 0.25);
        context.fillStyle = particle.color;
        context.save();
        context.translate(particle.x, particle.y);
        context.rotate(particle.rotation);
        context.fillRect(
          -particle.size / 2,
          -particle.size / 2,
          particle.size,
          particle.size * 0.62
        );
        context.restore();
      }
      context.globalAlpha = 1;

      if (alive > 0 || !secondWaveDone) {
        frameId = requestAnimationFrame(frame);
      }
    };

    frameId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(frameId);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
      aria-hidden="true"
    />
  );
}

const ordinal = (n: number): string => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
};

export function WinnerOverlay({
  label,
  color,
  byName,
  resultNumber,
  canRemove,
  canSpinAgain,
  reducedMotion,
  onRemove,
  onSpinAgain,
  onClose,
}: WinnerOverlayProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Long names scale down so the card never wraps into a wall of text.
  const nameFontSize =
    label.length <= 12 ? 38 : label.length <= 20 ? 32 : label.length <= 30 ? 26 : 21;

  return (
    <div className="absolute inset-0 z-20">
      <style>{`
        @keyframes wheel-winner-pop {
          0% { opacity: 0; transform: scale(0.9) translateY(10px); }
          100% { opacity: 1; transform: scale(1) translateY(0); }
        }
        @keyframes wheel-winner-fade {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
      <button
        type="button"
        aria-label="Dismiss winner"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-[#0b0b0b]/78"
        style={{ animation: "wheel-winner-fade 160ms linear both" }}
      />
      {!reducedMotion && <ConfettiCanvas />}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
        <div
          role="alertdialog"
          aria-label={`Winner: ${label}`}
          className="pointer-events-auto relative w-full max-w-[440px] overflow-hidden rounded-2xl border border-white/12 bg-[#141417] px-8 pb-7 pt-8 text-center"
          style={{
            animation: reducedMotion
              ? undefined
              : "wheel-winner-pop 260ms cubic-bezier(0.22, 1.2, 0.36, 1) both",
          }}
        >
          {/* Winner-colored crown bar */}
          <span
            className="absolute inset-x-0 top-0 h-1"
            style={{ backgroundColor: color }}
            aria-hidden="true"
          />

          <p className="text-[10.5px] font-semibold uppercase tracking-[0.34em] text-[#f95f4a]">
            We have a winner
          </p>

          <p
            className="mx-auto mt-3 max-w-full break-words leading-[1.12] text-[#fafafa]"
            style={{
              fontFamily: "var(--font-display, inherit)",
              fontSize: nameFontSize,
              fontWeight: 700,
            }}
          >
            {label}
          </p>

          <p className="mt-2.5 text-[12px] text-[#fafafa]/45">
            {ordinal(resultNumber)} result · spun by {byName}
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {canSpinAgain && (
              <button
                type="button"
                onClick={onSpinAgain}
                className="cursor-pointer rounded-full bg-[#f95f4a] px-5 py-2 text-[12.5px] font-semibold text-white transition-opacity hover:opacity-90"
              >
                Spin again
              </button>
            )}
            {canRemove && (
              <button
                type="button"
                onClick={onRemove}
                className="cursor-pointer rounded-full border border-white/12 px-4 py-2 text-[12.5px] font-medium text-[#fafafa]/85 transition-colors hover:bg-white/5"
              >
                Remove {label.length > 14 ? "name" : label}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-full border border-white/12 px-4 py-2 text-[12.5px] font-medium text-[#fafafa]/85 transition-colors hover:bg-white/5"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
