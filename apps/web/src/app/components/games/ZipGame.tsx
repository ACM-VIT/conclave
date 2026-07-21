"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { color, radius } from "@conclave/ui-tokens";
import {
  GameLobby,
  HEAD_FONT,
  useRemaining,
  type GameViewProps,
} from "./gameUi";

/* ------------------------------------------------------------------ */
/*  Wire types (matching publicView / playerView from the server)     */
/* ------------------------------------------------------------------ */

type CellCoord = { row: number; col: number };
type CellIndex = number;
type BarrierEdge = { from: CellIndex; to: CellIndex };
type WallEdge = { a: CellCoord; b: CellCoord };
type PlayerOutcome = "win" | "timeout";

type ZipPublic = {
  phase: "lobby" | "playing" | "results";
  gridSize: number;
  anchors: Record<string, number>;
  barriers: BarrierEdge[];
  deadCells: CellIndex[];
  serverNow: number;
  roundStartedAt: number | null;
  standings: Array<{
    playerId: string;
    playerName: string;
    cellsFilled: number;
    totalCells: number;
    outcome: PlayerOutcome | null;
    hintsUsed: number;
    solvedAt: number | null;
  }>;
  finishedCount: number;
  totalPlayers: number;
  currentRound: number;
  totalRounds: number;
  isFinalRound: boolean;
  scores: Array<{ playerId: string; playerName: string; score: number }>;
  result: {
    solutionPath: CellIndex[];
    winnerId: string | null;
    winnerName: string | null;
  } | null;
};

type ZipMe = {
  path: CellIndex[];
  outcome: PlayerOutcome | null;
  solvedAt: number | null;
  hintsUsed: number;
  hintAvailableAt: number;
  mistakes: number;
};

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const ZIP_GOLD = "#f6c744";
const ZIP_VIOLET = "#6c5ce7";
const GRID_BG = "#232327";
const GRID_LINE = "rgba(250, 250, 250, 0.10)";
const WALL_COLOR = "#fafafa";
const CHECKPOINT_BG = "#1a1a1a";
const CHECKPOINT_TEXT = "#ffffff";
const ERROR_RED = "#ff4d4f";
const CELL_PAD = 2;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const coordKey = (c: CellCoord): string => `${c.row},${c.col}`;
const cellEdgeKey = (a: CellIndex, b: CellIndex): string =>
  a < b ? `${a}:${b}` : `${b}:${a}`;
const cellToCoord = (cell: CellIndex, gridSize: number): CellCoord => ({
  row: Math.floor(cell / gridSize),
  col: cell % gridSize,
});
const coordToCell = (cell: CellCoord, gridSize: number): CellIndex =>
  cell.row * gridSize + cell.col;

const edgeKey = (a: CellCoord, b: CellCoord): string => {
  const k1 = coordKey(a);
  const k2 = coordKey(b);
  return k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
};

/** Interpolate between two hex colors. */
const lerpColor = (c1: string, c2: string, t: number): string => {
  const parse = (hex: string) => {
    const h = hex.replace("#", "");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  };
  const [r1, g1, b1] = parse(c1);
  const [r2, g2, b2] = parse(c2);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(r1 + (r2 - r1) * t);
  const g = clamp(g1 + (g2 - g1) * t);
  const b = clamp(b1 + (b2 - b1) * t);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
};

const statusText = (outcome: PlayerOutcome | null): string => {
  if (outcome === "win") return "Solved";
  if (outcome === "timeout") return "Timed out";
  return "Playing";
};

const formatElapsedTime = (ms: number): string => {
  const totalMs = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(totalMs / 60_000);
  const seconds = Math.floor(totalMs / 1_000) % 60;
  const milliseconds = (totalMs % 1_000).toString().padStart(3, "0");
  const secondPart = seconds.toString().padStart(2, "0");

  return minutes > 0
    ? `${minutes.toString().padStart(2, "0")}:${secondPart}:${milliseconds}`
    : `${secondPart}:${milliseconds}`;
};

const formatSolveTime = (solvedAt: number | null, roundStartedAt: number | null): string | null => {
  if (solvedAt == null || roundStartedAt == null) return null;

  const tenths = Math.max(0, Math.round((solvedAt - roundStartedAt) / 100));
  const minutes = Math.floor(tenths / 600).toString();
  const seconds = Math.floor((tenths % 600) / 10).toString().padStart(2, "0");
  return `${minutes}:${seconds}.${tenths % 10}`;
};

const useElapsedTime = (
  roundStartedAt: number | null | undefined,
  serverNow: number | null | undefined,
): number => {
  const [elapsed, setElapsed] = useState(0);
  const baseRef = useRef({ roundStartedAt, serverNow, at: Date.now() });

  useEffect(() => {
    if (roundStartedAt == null || serverNow == null) {
      setElapsed(0);
      return;
    }

    baseRef.current = { roundStartedAt, serverNow, at: Date.now() };
    const update = () => {
      const base = baseRef.current;
      if (base.roundStartedAt == null || base.serverNow == null) {
        setElapsed(0);
        return;
      }
      setElapsed(Math.max(0, base.serverNow - base.roundStartedAt + Date.now() - base.at));
    };
    update();
    const interval = window.setInterval(update, 50);
    return () => window.clearInterval(interval);
  }, [roundStartedAt, serverNow]);

  return elapsed;
};

/* ------------------------------------------------------------------ */
/*  SVG Grid component                                                 */
/* ------------------------------------------------------------------ */

function ZipGrid({
  gridSize,
  checkpoints,
  walls,
  deadCells,
  path,
  solutionPath,
  showSolution,
  onPointerDownCell,
  onPointerEnterCell,
  onPointerUp,
  flashCell,
}: {
  gridSize: number;
  checkpoints: CellCoord[];
  walls: WallEdge[];
  deadCells: CellCoord[];
  path: CellCoord[];
  solutionPath?: CellCoord[];
  showSolution: boolean;
  onPointerDownCell: (cell: CellCoord) => void;
  onPointerEnterCell: (cell: CellCoord) => void;
  onPointerUp: () => void;
  flashCell: CellCoord | null;
}) {
  const cellSize = 60;
  const totalSize = gridSize * cellSize;
  const activePointerIdRef = useRef<number | null>(null);
  const lastPointerCellRef = useRef<CellCoord | null>(null);
  const pathSet = useMemo(() => new Set(path.map(coordKey)), [path]);

  const cellFromPointer = (clientX: number, clientY: number, svg: SVGSVGElement): CellCoord | null => {
    const bounds = svg.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;

    const x = clientX - bounds.left;
    const y = clientY - bounds.top;
    if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return null;

    return {
      row: Math.min(gridSize - 1, Math.floor((y / bounds.height) * gridSize)),
      col: Math.min(gridSize - 1, Math.floor((x / bounds.width) * gridSize)),
    };
  };

  const moveThroughCells = (nextCell: CellCoord) => {
    const previous = lastPointerCellRef.current;
    if (!previous || (previous.row === nextCell.row && previous.col === nextCell.col)) return;

    const rowDelta = nextCell.row - previous.row;
    const colDelta = nextCell.col - previous.col;
    const rowStep = Math.sign(rowDelta);
    const colStep = Math.sign(colDelta);
    const moveRowsFirst = Math.abs(rowDelta) > Math.abs(colDelta);
    let row = previous.row;
    let col = previous.col;

    const visit = () => onPointerEnterCell({ row, col });
    const moveRows = () => {
      while (row !== nextCell.row) {
        row += rowStep;
        visit();
      }
    };
    const moveColumns = () => {
      while (col !== nextCell.col) {
        col += colStep;
        visit();
      }
    };

    if (moveRowsFirst) {
      moveRows();
      moveColumns();
    } else {
      moveColumns();
      moveRows();
    }
  };

  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    const cell = cellFromPointer(event.clientX, event.clientY, event.currentTarget);
    if (!cell) return;

    event.preventDefault();
    activePointerIdRef.current = event.pointerId;
    lastPointerCellRef.current = cell;
    event.currentTarget.setPointerCapture(event.pointerId);
    onPointerDownCell(cell);
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (activePointerIdRef.current !== event.pointerId) return;

    event.preventDefault();
    const cell = cellFromPointer(event.clientX, event.clientY, event.currentTarget);
    if (!cell) return;
    moveThroughCells(cell);
    lastPointerCellRef.current = cell;
  };

  const finishPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    if (activePointerIdRef.current !== event.pointerId) return;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    activePointerIdRef.current = null;
    lastPointerCellRef.current = null;
    onPointerUp();
  };

  // Path position lookup for gradient coloring.
  const pathIndexMap = useMemo(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < path.length; i++) m.set(coordKey(path[i]), i);
    return m;
  }, [path]);

  const displayPath = showSolution && solutionPath ? solutionPath : path;

  // Build SVG path segments with per-segment gradient colors.
  const pathSegments = useMemo(() => {
    if (displayPath.length < 2) return [];
    const segments: Array<{
      x1: number; y1: number;
      x2: number; y2: number;
      color: string;
    }> = [];
    for (let i = 0; i < displayPath.length - 1; i++) {
      const a = displayPath[i];
      const b = displayPath[i + 1];
      const t = displayPath.length > 1 ? i / (displayPath.length - 1) : 0;
      segments.push({
        x1: a.col * cellSize + cellSize / 2,
        y1: a.row * cellSize + cellSize / 2,
        x2: b.col * cellSize + cellSize / 2,
        y2: b.row * cellSize + cellSize / 2,
        color: lerpColor(ZIP_GOLD, ZIP_VIOLET, t),
      });
    }
    return segments;
  }, [displayPath, cellSize]);

  const headCell = path.length > 0 ? path[path.length - 1] : null;

  return (
    <svg
      viewBox={`0 0 ${totalSize} ${totalSize}`}
      style={{
        width: "100%",
        maxWidth: 400,
        aspectRatio: "1",
        touchAction: "none",
        userSelect: "none",
        display: "block",
        margin: "0 auto",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
    >
      {/* Background */}
      <rect width={totalSize} height={totalSize} rx={8} fill={GRID_BG} />

      {/* Grid lines */}
      {Array.from({ length: gridSize - 1 }, (_, i) => (
        <React.Fragment key={`lines-${i}`}>
          <line
            x1={(i + 1) * cellSize} y1={CELL_PAD}
            x2={(i + 1) * cellSize} y2={totalSize - CELL_PAD}
            stroke={GRID_LINE} strokeWidth={1}
          />
          <line
            x1={CELL_PAD} y1={(i + 1) * cellSize}
            x2={totalSize - CELL_PAD} y2={(i + 1) * cellSize}
            stroke={GRID_LINE} strokeWidth={1}
          />
        </React.Fragment>
      ))}

      {/* Visited cell tint */}
      {path.map((cell) => {
        const idx = pathIndexMap.get(coordKey(cell)) ?? 0;
        const t = path.length > 1 ? idx / (path.length - 1) : 0;
        const tintColor = lerpColor(ZIP_GOLD, ZIP_VIOLET, t);
        return (
          <rect
            key={`tint-${coordKey(cell)}`}
            x={cell.col * cellSize + 1}
            y={cell.row * cellSize + 1}
            width={cellSize - 2}
            height={cellSize - 2}
            rx={4}
            fill={tintColor}
            opacity={0.12}
          />
        );
      })}

      {/* Cells removed from this puzzle. */}
      {deadCells.map((cell) => (
        <g key={`dead-${coordKey(cell)}`}>
          <rect
            x={cell.col * cellSize + 1}
            y={cell.row * cellSize + 1}
            width={cellSize - 2}
            height={cellSize - 2}
            rx={4}
            fill="#111114"
          />
          <line
            x1={cell.col * cellSize + 12}
            y1={cell.row * cellSize + 12}
            x2={(cell.col + 1) * cellSize - 12}
            y2={(cell.row + 1) * cellSize - 12}
            stroke={GRID_LINE}
            strokeWidth={2}
          />
        </g>
      ))}

      {/* Path line segments */}
      {pathSegments.map((seg, i) => (
        <line
          key={`path-${i}`}
          x1={seg.x1} y1={seg.y1}
          x2={seg.x2} y2={seg.y2}
          stroke={seg.color}
          strokeWidth={cellSize * 0.38}
          strokeLinecap="round"
        />
      ))}

      {/* Head cell glow */}
      {headCell && !showSolution ? (
        <circle
          cx={headCell.col * cellSize + cellSize / 2}
          cy={headCell.row * cellSize + cellSize / 2}
          r={cellSize * 0.16}
          fill="#fff"
          opacity={0.7}
        >
          <animate
            attributeName="opacity"
            values="0.7;0.3;0.7"
            dur="1.5s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="r"
            values={`${cellSize * 0.16};${cellSize * 0.2};${cellSize * 0.16}`}
            dur="1.5s"
            repeatCount="indefinite"
          />
        </circle>
      ) : null}

      {/* Walls */}
      {walls.map((w) => {
        const horizontal = w.a.row === w.b.row;
        const wallThickness = 4;
        let x1: number, y1: number, x2: number, y2: number;
        if (horizontal) {
          const col = Math.max(w.a.col, w.b.col);
          x1 = col * cellSize;
          x2 = col * cellSize;
          y1 = Math.min(w.a.row, w.b.row) * cellSize + 4;
          y2 = Math.min(w.a.row, w.b.row) * cellSize + cellSize - 4;
        } else {
          const row = Math.max(w.a.row, w.b.row);
          x1 = Math.min(w.a.col, w.b.col) * cellSize + 4;
          x2 = Math.min(w.a.col, w.b.col) * cellSize + cellSize - 4;
          y1 = row * cellSize;
          y2 = row * cellSize;
        }
        return (
          <line
            key={`wall-${edgeKey(w.a, w.b)}`}
            x1={x1} y1={y1} x2={x2} y2={y2}
            stroke={WALL_COLOR}
            strokeWidth={wallThickness}
            strokeLinecap="round"
          />
        );
      })}

      {/* Checkpoint circles */}
      {checkpoints.map((cp, i) => {
        const cx = cp.col * cellSize + cellSize / 2;
        const cy = cp.row * cellSize + cellSize / 2;
        const visited = pathSet.has(coordKey(cp));
        const idx = pathIndexMap.get(coordKey(cp));
        const cpColor = visited && idx !== undefined
          ? lerpColor(ZIP_GOLD, ZIP_VIOLET, path.length > 1 ? idx / (path.length - 1) : 0)
          : CHECKPOINT_BG;
        return (
          <g key={`cp-${i}`}>
            <circle
              cx={cx} cy={cy}
              r={cellSize * 0.3}
              fill={cpColor}
            />
            <text
              x={cx} y={cy}
              textAnchor="middle"
              dominantBaseline="central"
              fill={CHECKPOINT_TEXT}
              fontSize={cellSize * 0.32}
              fontWeight={700}
              fontFamily={HEAD_FONT}
              style={{ pointerEvents: "none" }}
            >
              {i + 1}
            </text>
          </g>
        );
      })}

      {/* Flash cell (error feedback) */}
      {flashCell ? (
        <rect
          x={flashCell.col * cellSize + 2}
          y={flashCell.row * cellSize + 2}
          width={cellSize - 4}
          height={cellSize - 4}
          rx={6}
          fill={ERROR_RED}
          opacity={0.45}
        >
          <animate
            attributeName="opacity"
            values="0.45;0;0"
            dur="0.3s"
            fill="freeze"
          />
        </rect>
      ) : null}

    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Main renderer                                                      */
/* ------------------------------------------------------------------ */

export default function ZipGame({
  pub,
  me,
  players,
  isAdmin,
  readOnly = false,
  move,
}: GameViewProps<ZipPublic, ZipMe>) {
  const [localPath, setLocalPath] = useState<CellIndex[]>(me.path);
  const drawingRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [flashCell, setFlashCell] = useState<CellCoord | null>(null);
  const pathRef = useRef(localPath);

  const elapsedMs = useElapsedTime(pub.roundStartedAt, pub.serverNow);
  const hintCooldownMs = useRemaining(me.hintAvailableAt, pub.serverNow);
  const checkpoints = useMemo(
    () =>
      Object.entries(pub.anchors)
        .sort(([, a], [, b]) => a - b)
        .map(([cell]) => cellToCoord(Number(cell), pub.gridSize)),
    [pub.anchors, pub.gridSize],
  );
  const walls = useMemo(
    () =>
      pub.barriers.map(({ from, to }) => ({
        a: cellToCoord(from, pub.gridSize),
        b: cellToCoord(to, pub.gridSize),
      })),
    [pub.barriers, pub.gridSize],
  );
  const deadCells = useMemo(
    () => pub.deadCells.map((cell) => cellToCoord(cell, pub.gridSize)),
    [pub.deadCells, pub.gridSize],
  );
  const pathCoords = useMemo(
    () => localPath.map((cell) => cellToCoord(cell, pub.gridSize)),
    [localPath, pub.gridSize],
  );
  const solutionPath = useMemo(
    () => pub.result?.solutionPath.map((cell) => cellToCoord(cell, pub.gridSize)),
    [pub.result, pub.gridSize],
  );
  const totalCells = pub.gridSize * pub.gridSize - pub.deadCells.length;
  const mySolveTime = formatSolveTime(me.solvedAt, pub.roundStartedAt);
  const hintCooldownSeconds = Math.ceil(hintCooldownMs / 1000);
  const startCell = useMemo(() => {
    const anchor = Object.entries(pub.anchors).find(([, order]) => order === 1)?.[0];
    return anchor === undefined ? null : Number(anchor);
  }, [pub.anchors]);

  // Sync local path from server when server view changes.
  useEffect(() => {
    pathRef.current = me.path;
    setLocalPath(me.path);
  }, [me.path]);

  const updateLocalPath = useCallback((nextPath: CellIndex[]) => {
    pathRef.current = nextPath;
    setLocalPath(nextPath);
  }, []);

  // Wall set for local validation.
  const wallSet = useMemo(
    () => new Set(pub.barriers.map(({ from, to }) => cellEdgeKey(from, to))),
    [pub.barriers],
  );
  const deadCellSet = useMemo(() => new Set(pub.deadCells), [pub.deadCells]);
  const checkpointOrder = useMemo(
    () => new Map(Object.entries(pub.anchors).map(([cell, order]) => [Number(cell), order])),
    [pub.anchors],
  );

  const submitPath = useCallback(
    async (cells: CellIndex[]) => {
      if (busyRef.current) return;

      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const result = await move("move", { cells });
        if (!result.success) {
          setError(result.error ?? "Invalid move");
          updateLocalPath(me.path);
        }
      } catch {
        setError("Something went wrong");
        updateLocalPath(me.path);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [me.path, move, updateLocalPath],
  );

  const isValidLocalMove = useCallback(
    (currentPath: CellIndex[], next: CellIndex): boolean => {
      if (currentPath.length === 0) return false;
      const head = currentPath[currentPath.length - 1];

      // Orthogonal adjacency.
      const dr = Math.abs(Math.floor(next / pub.gridSize) - Math.floor(head / pub.gridSize));
      const dc = Math.abs((next % pub.gridSize) - (head % pub.gridSize));
      if (dr + dc !== 1) return false;

      // Wall check.
      if (wallSet.has(cellEdgeKey(head, next))) return false;

      if (deadCellSet.has(next)) return false;

      // Revisit check.
      if (currentPath.includes(next)) return false;

      // Checkpoint ordering.
      let nextExpectedCp = 1;
      for (const cell of currentPath) {
        if (checkpointOrder.get(cell) === nextExpectedCp) nextExpectedCp++;
      }
      const checkpoint = checkpointOrder.get(next);
      if (checkpoint !== undefined && checkpoint !== nextExpectedCp) return false;

      return true;
    },
    [checkpointOrder, deadCellSet, pub.gridSize, wallSet],
  );

  const handlePointerDownCell = useCallback(
    (cell: CellCoord) => {
      if (readOnly || me.outcome != null || pub.phase !== "playing" || startCell == null) return;

      const nextCell = coordToCell(cell, pub.gridSize);
      const currentPath = pathRef.current;

      // Can start from checkpoint 1 (fresh) or resume from the head.
      const head = currentPath[currentPath.length - 1];
      if (currentPath.length === 0 || nextCell === startCell) {
        // Fresh start.
        updateLocalPath([startCell]);
        drawingRef.current = true;
        return;
      }
      if (head === nextCell) {
        // Resume from head.
        drawingRef.current = true;
        return;
      }

      // Check if this cell is in the path (backward drag to truncate).
      const idx = currentPath.indexOf(nextCell);
      if (idx >= 0) {
        updateLocalPath(currentPath.slice(0, idx + 1));
        drawingRef.current = true;
        return;
      }

      // Invalid start point — flash.
      setFlashCell(cell);
      setTimeout(() => setFlashCell(null), 300);
    },
    [me.outcome, pub.gridSize, pub.phase, readOnly, startCell, updateLocalPath],
  );

  const handlePointerEnterCell = useCallback(
    (cell: CellCoord) => {
      if (!drawingRef.current || readOnly || me.outcome != null || pub.phase !== "playing") return;

      const nextCell = coordToCell(cell, pub.gridSize);
      const currentPath = pathRef.current;

      // Check for backward drag (retraction).
      if (currentPath.length >= 2) {
        const secondToLast = currentPath[currentPath.length - 2];
        if (nextCell === secondToLast) {
          updateLocalPath(currentPath.slice(0, -1));
          return;
        }
      }

      // Check for valid forward move.
      if (isValidLocalMove(currentPath, nextCell)) {
        updateLocalPath([...currentPath, nextCell]);
        return;
      }

      // Invalid — flash.
      if (!currentPath.includes(nextCell)) {
        setFlashCell(cell);
        setTimeout(() => setFlashCell(null), 300);
      }
    },
    [isValidLocalMove, me.outcome, pub.gridSize, pub.phase, readOnly, updateLocalPath],
  );

  const handlePointerUp = useCallback(() => {
    if (drawingRef.current) {
      drawingRef.current = false;
      void submitPath(pathRef.current);
    }
  }, [submitPath]);

  const runMove = async (type: string, payload?: unknown) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await move(type, payload);
      if (!result.success) setError(result.error ?? "Something went wrong");
    } catch {
      setError("Something went wrong");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleUndo = () => {
    if (localPath.length <= 1 || readOnly || me.outcome != null) return;
    const newPath = localPath.slice(0, -1);
    updateLocalPath(newPath);
    void submitPath(newPath);
  };

  const handleReset = () => {
    if (readOnly || me.outcome != null || startCell == null) return;
    updateLocalPath([startCell]);
    void runMove("reset");
  };

  const handleHint = () => {
    if (readOnly || me.outcome != null || hintCooldownMs > 0) return;
    void runMove("hint");
  };

  // --- Lobby ---
  if (pub.phase === "lobby") {
    return (
      <GameLobby
        gameId="zip"
        title="Draw one path, fill every cell"
        blurb={`Race to complete a ${pub.gridSize}×${pub.gridSize} grid puzzle. Visit numbered checkpoints in order. Fewest hints and fastest time wins.`}
        players={players}
        isAdmin={isAdmin}
        readOnly={readOnly}
        canStart={players.length >= 1}
        busy={busy}
        disabledLabel="Need at least 1 player"
        startLabel="Start Zip"
        busyLabel="Starting Zip…"
        error={error}
        onStart={() => void runMove("start")}
      />
    );
  }

  // --- Results ---
  if (pub.phase === "results" && pub.result) {
    const multiRound = pub.totalRounds > 1;
    const winner = pub.standings.find((entry) => entry.playerId === pub.result?.winnerId);
    const winnerSolveTime = winner
      ? formatSolveTime(winner.solvedAt, pub.roundStartedAt)
      : null;
    return (
      <div style={{ padding: "4px 2px" }}>
        {multiRound ? (
          <p style={{ fontSize: 11, color: color.textFaint, fontFamily: HEAD_FONT, textAlign: "center", margin: "0 0 2px" }}>
            Round {pub.currentRound} of {pub.totalRounds}
          </p>
        ) : null}
        <p style={{ fontFamily: HEAD_FONT, fontSize: 18, color: color.text, margin: "0 0 4px", textAlign: "center" }}>
          {pub.isFinalRound
            ? multiRound ? "Game over" : pub.result.winnerName ? "Puzzle complete" : "Time's up"
            : pub.result.winnerName ? "Round complete" : "No winner"}
        </p>
        {pub.result.winnerName ? (
          <p style={{ fontSize: 13, color: ZIP_GOLD, textAlign: "center", margin: "0 0 10px" }}>
            {pub.result.winnerName} solved it first{winnerSolveTime ? ` in ${winnerSolveTime}` : ""}
          </p>
        ) : null}

        {/* Show solved grid */}
        <ZipGrid
          gridSize={pub.gridSize}
          checkpoints={checkpoints}
          walls={walls}
          deadCells={deadCells}
          path={me.outcome === "win" ? pathCoords : []}
          solutionPath={solutionPath}
          showSolution={true}
          onPointerDownCell={() => {}}
          onPointerEnterCell={() => {}}
          onPointerUp={() => {}}
          flashCell={null}
        />

        {/* Score table */}
        {multiRound && pub.scores.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            <p style={{ fontSize: 11, color: color.textFaint, fontFamily: HEAD_FONT, margin: "0 0 6px" }}>
              {pub.isFinalRound ? "Final scores" : "Scores"}
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {pub.scores.map((entry, i) => (
                <div
                  key={entry.playerId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "7px 10px",
                    borderRadius: radius.sm,
                    background: i === 0 && pub.isFinalRound ? `${ZIP_GOLD}22` : "transparent",
                  }}
                >
                  <span style={{ width: 16, fontSize: 12, color: i === 0 ? ZIP_GOLD : color.textFaint, fontFamily: HEAD_FONT, fontWeight: 500 }}>
                    {i + 1}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {entry.playerName}
                  </span>
                  <span style={{ fontSize: 12, color: ZIP_GOLD, fontFamily: HEAD_FONT, fontWeight: 600 }}>
                    {entry.score} pt{entry.score !== 1 ? "s" : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 12 }}>
            {pub.standings.map((entry, i) => {
              const solveTime = formatSolveTime(entry.solvedAt, pub.roundStartedAt);
              const hintText = entry.hintsUsed > 0
                ? `${entry.hintsUsed} hint${entry.hintsUsed > 1 ? "s" : ""}`
                : "No hints";
              return (
                <div
                key={entry.playerId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "7px 10px",
                  borderRadius: radius.sm,
                  background: entry.outcome === "win" ? `${ZIP_GOLD}22` : "transparent",
                }}
              >
                <span style={{ width: 16, fontSize: 12, color: i === 0 && entry.outcome === "win" ? ZIP_GOLD : color.textFaint, fontFamily: HEAD_FONT, fontWeight: 500 }}>
                  {i + 1}
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {entry.playerName}
                </span>
                <span style={{ fontSize: 12, color: color.textMuted, fontFamily: HEAD_FONT }}>
                  {entry.outcome === "win"
                    ? `${solveTime ? `Solved in ${solveTime}` : "Solved"} · ${hintText}`
                    : statusText(entry.outcome)}
                </span>
              </div>
              );
            })}
          </div>
        )}

        {!pub.isFinalRound && isAdmin && !readOnly ? (
          <button
            disabled={busy}
            onClick={() => void runMove("nextRound")}
            style={{
              width: "100%",
              marginTop: 12,
              padding: "10px 0",
              borderRadius: radius.md,
              border: "none",
              background: ZIP_GOLD,
              color: "#1a1a1a",
              fontFamily: HEAD_FONT,
              fontWeight: 700,
              fontSize: 15,
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.5 : 1,
            }}
          >
            Next Round
          </button>
        ) : !pub.isFinalRound ? (
          <p style={{ fontSize: 12, color: color.textMuted, textAlign: "center", margin: "12px 0 0" }}>
            Waiting for host to start next round...
          </p>
        ) : null}
      </div>
    );
  }

  // --- Playing ---

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <p style={{ margin: 0, color: ZIP_GOLD, fontFamily: HEAD_FONT, fontSize: 12 }}>
            Zip{pub.totalRounds > 1 ? ` · Round ${pub.currentRound}/${pub.totalRounds}` : ""}
          </p>
          <p style={{ margin: "2px 0 0", color: color.textFaint, fontSize: 11 }}>
            {pub.finishedCount}/{pub.totalPlayers} finished
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <p style={{ margin: 0, color: color.textFaint, fontFamily: HEAD_FONT, fontSize: 10 }}>
            Elapsed
          </p>
          <p style={{ margin: "2px 0 0", color: color.text, fontFamily: HEAD_FONT, fontSize: 16 }}>
            {formatElapsedTime(elapsedMs)}
          </p>
        </div>
      </div>

      {/* Grid */}
      <ZipGrid
        gridSize={pub.gridSize}
        checkpoints={checkpoints}
        walls={walls}
        deadCells={deadCells}
        path={pathCoords}
        showSolution={false}
        onPointerDownCell={handlePointerDownCell}
        onPointerEnterCell={handlePointerEnterCell}
        onPointerUp={handlePointerUp}
        flashCell={flashCell}
      />

      {/* Progress */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{
          flex: 1,
          height: 4,
          borderRadius: 2,
          background: color.surfaceRaised,
          overflow: "hidden",
        }}>
          <div style={{
            width: `${(localPath.length / totalCells) * 100}%`,
            height: "100%",
            borderRadius: 2,
            background: `linear-gradient(90deg, ${ZIP_GOLD}, ${ZIP_VIOLET})`,
            transition: "width 120ms ease",
          }} />
        </div>
        <span style={{ fontSize: 11, color: color.textFaint, fontFamily: HEAD_FONT, whiteSpace: "nowrap" }}>
          {localPath.length}/{totalCells}
        </span>
      </div>

      {/* Action buttons */}
      {!me.outcome && !readOnly ? (
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <button
            onClick={handleUndo}
            disabled={localPath.length <= 1 || busy}
            style={{
              padding: "8px 16px",
              borderRadius: radius.md,
              border: `1px solid ${color.border}`,
              background: "transparent",
              color: color.textMuted,
              fontFamily: HEAD_FONT,
              fontSize: 13,
              fontWeight: 500,
              cursor: localPath.length <= 1 || busy ? "default" : "pointer",
              opacity: localPath.length <= 1 || busy ? 0.4 : 1,
            }}
          >
            ↩ Undo
          </button>
          <button
            onClick={handleReset}
            disabled={localPath.length <= 1 || busy}
            style={{
              padding: "8px 16px",
              borderRadius: radius.md,
              border: `1px solid ${color.border}`,
              background: "transparent",
              color: color.textMuted,
              fontFamily: HEAD_FONT,
              fontSize: 13,
              fontWeight: 500,
              cursor: localPath.length <= 1 || busy ? "default" : "pointer",
              opacity: localPath.length <= 1 || busy ? 0.4 : 1,
            }}
          >
            ⟲ Reset
          </button>
          <button
            onClick={handleHint}
            disabled={busy || hintCooldownMs > 0}
            style={{
              padding: "8px 16px",
              borderRadius: radius.md,
              border: `1px solid ${color.border}`,
              background: "transparent",
              color: ZIP_GOLD,
              fontFamily: HEAD_FONT,
              fontSize: 13,
              fontWeight: 500,
              cursor: busy || hintCooldownMs > 0 ? "default" : "pointer",
              opacity: busy || hintCooldownMs > 0 ? 0.4 : 1,
            }}
          >
            💡 Hint{hintCooldownMs > 0 ? ` (${hintCooldownSeconds}s)` : me.hintsUsed > 0 ? ` (${me.hintsUsed})` : ""}
          </button>
        </div>
      ) : null}

      {/* Outcome banner */}
      {me.outcome ? (
        <div style={{
          textAlign: "center",
          padding: "10px 14px",
          borderRadius: radius.md,
          background: me.outcome === "win" ? `${ZIP_GOLD}18` : color.surfaceRaised,
        }}>
          <span style={{ fontSize: 14, fontFamily: HEAD_FONT, color: me.outcome === "win" ? ZIP_GOLD : color.textMuted }}>
            {me.outcome === "win" ? `Solved${mySolveTime ? ` in ${mySolveTime}` : "!"}` : "Time's up"}
          </span>
        </div>
      ) : null}

      {/* Live standings */}
      {pub.standings.length > 0 && pub.phase === "playing" ? (
        <div style={{ paddingTop: 10, borderTop: `1px solid ${color.border}` }}>
          <p style={{ fontSize: 11, color: color.textFaint, fontFamily: HEAD_FONT, margin: "0 0 6px" }}>Standings</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {pub.standings.map((entry, i) => {
              const solveTime = formatSolveTime(entry.solvedAt, pub.roundStartedAt);
              return (
                <div
                key={entry.playerId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "5px 10px",
                  borderRadius: radius.sm,
                  background: entry.outcome === "win" ? `${ZIP_GOLD}22` : "transparent",
                }}
              >
                <span style={{ width: 16, fontSize: 12, color: i === 0 && entry.outcome === "win" ? ZIP_GOLD : color.textFaint, fontFamily: HEAD_FONT, fontWeight: 500 }}>
                  {i + 1}
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {entry.playerName}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{
                    width: 60,
                    height: 4,
                    borderRadius: 2,
                    background: color.surfaceRaised,
                    overflow: "hidden",
                  }}>
                    <div style={{
                      width: `${(entry.cellsFilled / entry.totalCells) * 100}%`,
                      height: "100%",
                      borderRadius: 2,
                      background: entry.outcome === "win" ? ZIP_GOLD : color.textFaint,
                    }} />
                  </div>
                  <span style={{ fontSize: 11, color: entry.outcome === "win" ? ZIP_GOLD : color.textMuted, fontFamily: HEAD_FONT, whiteSpace: "nowrap" }}>
                    {entry.outcome === "win"
                      ? solveTime ? `Solved in ${solveTime}` : "Solved"
                      : entry.outcome
                        ? statusText(entry.outcome)
                        : `${entry.cellsFilled}/${entry.totalCells}`}
                  </span>
                </div>
              </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {error ? <p style={{ margin: 0, color: color.danger, fontSize: 12 }}>{error}</p> : null}
    </div>
  );
}
