import type { RenderCommand } from "../../core/exports/renderList";

type Point = { x: number; y: number };

const FONT_STACK =
  'Virgil, "Segoe Print", "Comic Sans MS", "Marker Felt", cursive';
const ROTATION_EPSILON = 0.0001;

/* ── deterministic RNG ── */

const seedFrom = (value: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const createRng = (seed: number) => {
  let state = seed || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
};

const jitter = (rng: () => number, amount: number): number =>
  (rng() * 2 - 1) * amount;

const applyRotation = (
  ctx: CanvasRenderingContext2D,
  rotation: number,
  center: Point,
  draw: () => void,
) => {
  if (Math.abs(rotation) < ROTATION_EPSILON) {
    draw();
    return;
  }

  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(rotation);
  ctx.translate(-center.x, -center.y);
  draw();
  ctx.restore();
};


const drawSketchyPath = (
  ctx: CanvasRenderingContext2D,
  points: Point[],
  rng: () => number,
  wobble: number,
) => {
  if (points.length === 0) return;

  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, 1.5, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  ctx.beginPath();
  const first = points[0];
  ctx.moveTo(
    first.x + jitter(rng, wobble),
    first.y + jitter(rng, wobble),
  );

  for (let i = 1; i < points.length - 1; i += 1) {
    const curr = points[i];
    const next = points[i + 1];
    const midX = (curr.x + next.x) / 2 + jitter(rng, wobble);
    const midY = (curr.y + next.y) / 2 + jitter(rng, wobble);
    ctx.quadraticCurveTo(
      curr.x + jitter(rng, wobble),
      curr.y + jitter(rng, wobble),
      midX,
      midY,
    );
  }

  const last = points[points.length - 1];
  ctx.lineTo(
    last.x + jitter(rng, wobble),
    last.y + jitter(rng, wobble),
  );
};

const renderStroke = (
  ctx: CanvasRenderingContext2D,
  points: Point[],
  color: string,
  width: number,
  opacity: number,
  seed: number,
) => {
  if (points.length === 0) return;
  const wobble = Math.max(0.2, Math.min(1.2, width * 0.15));
  const rng = createRng(seed);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalAlpha = opacity;

  drawSketchyPath(ctx, points, rng, wobble);
  ctx.stroke();
  ctx.restore();
};

const renderLine = (
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  color: string,
  width: number,
  seed: number,
) => {
  const wobble = Math.max(0.3, Math.min(1.0, width * 0.2));
  const rng = createRng(seed);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";

  ctx.beginPath();
  ctx.moveTo(from.x + jitter(rng, wobble), from.y + jitter(rng, wobble));
  ctx.lineTo(to.x + jitter(rng, wobble), to.y + jitter(rng, wobble));
  ctx.stroke();
  ctx.restore();
};

const renderArrow = (
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  color: string,
  width: number,
  seed: number,
) => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) {
    renderLine(ctx, from, to, color, width, seed);
    return;
  }

  const wobble = Math.max(0.3, Math.min(1.0, width * 0.2));
  const rng = createRng(seed + 17);
  const angle = Math.atan2(dy, dx);
  const targetHeadLength = Math.min(38, Math.max(12, width * 3.6));
  const headLength = Math.min(length * 0.45, targetHeadLength);
  const spread = Math.PI / 5.8;
  const left = {
    x: to.x - headLength * Math.cos(angle - spread),
    y: to.y - headLength * Math.sin(angle - spread),
  };
  const right = {
    x: to.x - headLength * Math.cos(angle + spread),
    y: to.y - headLength * Math.sin(angle + spread),
  };

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.beginPath();
  ctx.moveTo(from.x + jitter(rng, wobble), from.y + jitter(rng, wobble));
  ctx.lineTo(to.x + jitter(rng, wobble), to.y + jitter(rng, wobble));
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(to.x + jitter(rng, wobble), to.y + jitter(rng, wobble));
  ctx.lineTo(left.x + jitter(rng, wobble), left.y + jitter(rng, wobble));
  ctx.moveTo(to.x + jitter(rng, wobble), to.y + jitter(rng, wobble));
  ctx.lineTo(right.x + jitter(rng, wobble), right.y + jitter(rng, wobble));
  ctx.stroke();

  ctx.restore();
};

const renderRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  strokeWidth: number,
  fillColor: string | undefined,
  seed: number,
) => {
  const rng = createRng(seed);
  const wobble = Math.max(0.3, Math.min(1.0, strokeWidth * 0.18));
  const r = Math.min(8, Math.min(w, h) * 0.12);

  ctx.save();

  if (fillColor && fillColor !== "transparent") {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fillStyle = fillColor;
    ctx.globalAlpha = 0.35;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.beginPath();
  ctx.moveTo(x + r + jitter(rng, wobble), y + jitter(rng, wobble));
  ctx.lineTo(x + w - r + jitter(rng, wobble), y + jitter(rng, wobble));
  ctx.quadraticCurveTo(
    x + w + jitter(rng, wobble * 0.5),
    y + jitter(rng, wobble * 0.5),
    x + w + jitter(rng, wobble),
    y + r + jitter(rng, wobble),
  );
  ctx.lineTo(x + w + jitter(rng, wobble), y + h - r + jitter(rng, wobble));
  ctx.quadraticCurveTo(
    x + w + jitter(rng, wobble * 0.5),
    y + h + jitter(rng, wobble * 0.5),
    x + w - r + jitter(rng, wobble),
    y + h + jitter(rng, wobble),
  );
  ctx.lineTo(x + r + jitter(rng, wobble), y + h + jitter(rng, wobble));
  ctx.quadraticCurveTo(
    x + jitter(rng, wobble * 0.5),
    y + h + jitter(rng, wobble * 0.5),
    x + jitter(rng, wobble),
    y + h - r + jitter(rng, wobble),
  );
  ctx.lineTo(x + jitter(rng, wobble), y + r + jitter(rng, wobble));
  ctx.quadraticCurveTo(
    x + jitter(rng, wobble * 0.5),
    y + jitter(rng, wobble * 0.5),
    x + r + jitter(rng, wobble),
    y + jitter(rng, wobble),
  );
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
};

/**
 * Renders a hand-drawn ellipse — Excalidraw-style.
 */
const renderEllipse = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  strokeWidth: number,
  fillColor: string | undefined,
  seed: number,
) => {
  const rng = createRng(seed);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const wobble = Math.max(0.3, Math.min(1.0, strokeWidth * 0.15));
  const segments = Math.max(24, Math.ceil((rx + ry) / 4));

  const points: Point[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    points.push({
      x: cx + Math.cos(angle) * rx,
      y: cy + Math.sin(angle) * ry,
    });
  }

  ctx.save();

  if (fillColor && fillColor !== "transparent") {
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = fillColor;
    ctx.globalAlpha = 0.35;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  drawSketchyPath(ctx, points, rng, wobble);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
};


const renderGrid = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) => {
  ctx.fillStyle = "#121212";
  ctx.fillRect(0, 0, width, height);

  const step = 20;
  const dotR = 0.6;
  ctx.fillStyle = "rgba(255, 255, 255, 0.06)";

  for (let x = step; x < width; x += step) {
    for (let y = step; y < height; y += step) {
      ctx.beginPath();
      ctx.arc(x, y, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const major = step * 5;
  ctx.fillStyle = "rgba(169, 165, 255, 0.05)";
  for (let x = major; x < width; x += major) {
    for (let y = major; y < height; y += major) {
      ctx.beginPath();
      ctx.arc(x, y, 1.0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
};


const renderStickyNote = (
  ctx: CanvasRenderingContext2D,
  element: Extract<RenderCommand, { type: "sticky" }>,
) => {
  const { x, y, width: w, height: h } = element;
  const r = 3;
  const textInset = 8;
  const contentX = x + textInset;
  const contentY = y + textInset;
  const contentW = Math.max(0, w - textInset * 2);
  const contentH = Math.max(0, h - textInset * 2);
  const scrollOffset = Math.max(0, element.stickyScrollOffset ?? 0);

  ctx.save();

  ctx.shadowColor = "rgba(0, 0, 0, 0.25)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 3;

  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = element.color;
  ctx.fill();

  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  ctx.strokeStyle = "rgba(0,0,0,0.12)";
  ctx.lineWidth = 0.5;
  ctx.stroke();

  const fold = 10;
  ctx.beginPath();
  ctx.moveTo(x + w - fold, y + h);
  ctx.lineTo(x + w, y + h - fold);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  ctx.fillStyle = "rgba(0,0,0,0.06)";
  ctx.fill();

  ctx.fillStyle = element.textColor;
  ctx.font = `${element.fontSize}px ${FONT_STACK}`;
  ctx.globalAlpha = 0.95;
  const lines = element.text.split("\n");
  const lh = element.fontSize * 1.3;
  ctx.save();
  ctx.beginPath();
  ctx.rect(contentX, contentY, contentW, contentH);
  ctx.clip();
  lines.forEach((line, i) => {
    const baseline = contentY + element.fontSize + i * lh - scrollOffset;
    ctx.fillText(line, contentX + 2, baseline, Math.max(0, contentW - 4));
  });
  ctx.restore();

  ctx.restore();
};


export const renderCanvas = (
  ctx: CanvasRenderingContext2D,
  elements: RenderCommand[],
  width: number,
  height: number,
  imageCache?: Map<string, HTMLImageElement>,
) => {
  ctx.clearRect(0, 0, width, height);
  ctx.save();

  renderGrid(ctx, width, height);

  for (const element of elements) {
    const seed = seedFrom(element.id);

    switch (element.type) {
      case "stroke": {
        const rotation = element.rotation ?? 0;
        if (Math.abs(rotation) < ROTATION_EPSILON || element.points.length === 0) {
          renderStroke(
            ctx,
            element.points,
            element.color,
            element.width,
            element.opacity ?? 1,
            seed,
          );
          break;
        }

        const xs = element.points.map((point) => point.x);
        const ys = element.points.map((point) => point.y);
        const center = {
          x: (Math.min(...xs) + Math.max(...xs)) / 2,
          y: (Math.min(...ys) + Math.max(...ys)) / 2,
        };
        applyRotation(ctx, rotation, center, () => {
          renderStroke(
            ctx,
            element.points,
            element.color,
            element.width,
            element.opacity ?? 1,
            seed,
          );
        });
        break;
      }

      case "shape": {
        const x = Math.min(element.x, element.x + element.width);
        const y = Math.min(element.y, element.y + element.height);
        const w = Math.abs(element.width);
        const h = Math.abs(element.height);
        const rotation = element.rotation ?? 0;
        const center = { x: x + w / 2, y: y + h / 2 };
        applyRotation(ctx, rotation, center, () => {
          if (element.shape === "rect") {
            renderRect(
              ctx,
              x,
              y,
              w,
              h,
              element.strokeColor,
              element.strokeWidth,
              element.fillColor,
              seed,
            );
          } else if (element.shape === "ellipse") {
            renderEllipse(
              ctx,
              x,
              y,
              w,
              h,
              element.strokeColor,
              element.strokeWidth,
              element.fillColor,
              seed,
            );
          } else if (element.shape === "line") {
            renderLine(
              ctx,
              { x: element.x, y: element.y },
              { x: element.x + element.width, y: element.y + element.height },
              element.strokeColor,
              element.strokeWidth,
              seed,
            );
          } else if (element.shape === "arrow") {
            renderArrow(
              ctx,
              { x: element.x, y: element.y },
              { x: element.x + element.width, y: element.y + element.height },
              element.strokeColor,
              element.strokeWidth,
              seed,
            );
          }
        });
        break;
      }

      case "text": {
        if (element.text.trim().length === 0) break;

        const lines = element.text.split("\n");
        const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
        const textWidth = Math.max(40, element.width ?? longest * element.fontSize * 0.62);
        const lineHeight = element.fontSize * 1.3;
        const textHeight = Math.max(
          element.fontSize * 1.4,
          element.height ?? lines.length * lineHeight
        );
        const rotation = element.rotation ?? 0;
        const center = {
          x: element.x + textWidth / 2,
          y: element.y + textHeight / 2,
        };

        applyRotation(ctx, rotation, center, () => {
          ctx.save();
          ctx.fillStyle = element.color;
          ctx.font = `${element.fontSize}px ${FONT_STACK}`;
          ctx.globalAlpha = 1;
          lines.forEach((line, index) => {
            if (line.length === 0) return;
            ctx.fillText(line, element.x, element.y + element.fontSize + index * lineHeight);
          });
          ctx.restore();
        });
        break;
      }

      case "sticky": {
        const rotation = element.rotation ?? 0;
        const center = {
          x: element.x + element.width / 2,
          y: element.y + element.height / 2,
        };
        applyRotation(ctx, rotation, center, () => {
          renderStickyNote(ctx, element);
        });
        break;
      }

      case "image": {
        const img = imageCache?.get(element.src);
        if (!img) break;
        const rotation = element.rotation ?? 0;
        const center = {
          x: element.x + element.width / 2,
          y: element.y + element.height / 2,
        };
        applyRotation(ctx, rotation, center, () => {
          ctx.save();
          ctx.shadowColor = "rgba(0, 0, 0, 0.2)";
          ctx.shadowBlur = 8;
          ctx.shadowOffsetX = 1;
          ctx.shadowOffsetY = 2;
          ctx.drawImage(img, element.x, element.y, element.width, element.height);
          ctx.restore();
        });
        break;
      }
    }
  }

  ctx.restore();
};
