export type CellIndex = number;
export type AnchorMap = Record<CellIndex, number>;

export interface BarrierEdge {
  from: CellIndex;
  to: CellIndex;
}

export const MIN_GRID_SIZE = 6;
export const MAX_GRID_SIZE = 9;

export const ANCHOR_RANGES = {
  6: { min: 6, max: 12 },
  7: { min: 7, max: 14 },
  8: { min: 8, max: 16 },
  9: { min: 9, max: 18 },
} as const satisfies Record<number, { min: number; max: number }>;

export type SupportedGridSize = keyof typeof ANCHOR_RANGES;

export interface PuzzleConfig {
  size: SupportedGridSize;
  anchorCount: number;
  seed?: number;
}

export interface GeneratedPuzzle extends PuzzleConfig {
  seed: number;
  solutionPath: CellIndex[];
  anchors: AnchorMap;
  barriers: BarrierEdge[];
  deadCells: CellIndex[];
}

export type RandomSource = () => number;

function randomIntInclusive(min: number, max: number, random: RandomSource): number {
  return min + Math.floor(random() * (max - min + 1));
}

function randomSeed(): number {
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}

export function createSeededRandom(seed: number): RandomSource {
  if (!Number.isFinite(seed)) throw new RangeError("Puzzle seed must be a finite number.");

  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function isSupportedGridSize(size: number): size is SupportedGridSize {
  return Object.hasOwn(ANCHOR_RANGES, size);
}

function validatePuzzleConfig(config: PuzzleConfig): void {
  if (!Number.isInteger(config.size) || !isSupportedGridSize(config.size)) {
    throw new RangeError(`Puzzle size must be an integer from ${MIN_GRID_SIZE} to ${MAX_GRID_SIZE}.`);
  }

  const range = ANCHOR_RANGES[config.size];
  if (
    !Number.isInteger(config.anchorCount) ||
    config.anchorCount < range.min ||
    config.anchorCount > range.max
  ) {
    throw new RangeError(
      `Puzzle anchor count for ${config.size}x${config.size} must be between ${range.min} and ${range.max}.`,
    );
  }

  if (config.seed !== undefined && !Number.isFinite(config.seed)) {
    throw new RangeError("Puzzle seed must be a finite number.");
  }
}

export function edgeKey(a: CellIndex, b: CellIndex): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function generateRandomPuzzleConfig(seed = randomSeed()): PuzzleConfig {
  const random = createSeededRandom(seed);
  const size = randomIntInclusive(MIN_GRID_SIZE, MAX_GRID_SIZE, random) as SupportedGridSize;
  const range = ANCHOR_RANGES[size];

  return {
    size,
    anchorCount: randomIntInclusive(range.min, range.max, random),
    seed,
  };
}

function baseSerpentinePath(size: SupportedGridSize): CellIndex[] {
  const path: CellIndex[] = [];

  for (let row = 0; row < size; row += 1) {
    if (row % 2 === 0) {
      for (let col = 0; col < size; col += 1) path.push(row * size + col);
    } else {
      for (let col = size - 1; col >= 0; col -= 1) path.push(row * size + col);
    }
  }

  return path;
}

function neighborsOf(index: CellIndex, size: SupportedGridSize): CellIndex[] {
  const row = Math.floor(index / size);
  const col = index % size;
  const neighbors: CellIndex[] = [];

  if (row > 0) neighbors.push(index - size);
  if (col + 1 < size) neighbors.push(index + 1);
  if (row + 1 < size) neighbors.push(index + size);
  if (col > 0) neighbors.push(index - 1);

  return neighbors;
}

function applyBackbiteMove(path: CellIndex[], size: SupportedGridSize, random: RandomSource): boolean {
  const lastIndex = path.length - 1;
  const useStart = random() < 0.5;
  const endpoint = useStart ? path[0] : path[lastIndex];
  const neighbors = neighborsOf(endpoint, size);
  const neighbor = neighbors[randomIntInclusive(0, neighbors.length - 1, random)];
  const neighborIndex = path.indexOf(neighbor);

  if (useStart) {
    if (neighborIndex <= 1) return false;

    const moved = path.slice(1, neighborIndex).reverse();
    moved.push(endpoint, ...path.slice(neighborIndex));
    path.splice(0, path.length, ...moved);
    return true;
  }

  if (neighborIndex < 0 || neighborIndex >= lastIndex - 1) return false;

  const moved = path.slice(0, neighborIndex + 1);
  moved.push(endpoint, ...path.slice(neighborIndex + 1, lastIndex).reverse());
  path.splice(0, path.length, ...moved);
  return true;
}

function randomizePath(path: CellIndex[], size: SupportedGridSize, random: RandomSource): void {
  // Use N^2 moves for proper mixing, where N is the number of cells (size * size)
  const targetMoves = size * size * size * size;
  const maxAttempts = targetMoves * 10;
  let acceptedMoves = 0;

  for (let attempt = 0; attempt < maxAttempts && acceptedMoves < targetMoves; attempt += 1) {
    if (applyBackbiteMove(path, size, random)) acceptedMoves += 1;
  }
}

function transformCell(index: CellIndex, size: SupportedGridSize, transform: number): CellIndex {
  const row = Math.floor(index / size);
  const col = index % size;
  let nextRow = row;
  let nextCol = col;

  switch (transform) {
    case 0:
      break;
    case 1:
      nextRow = col;
      nextCol = size - 1 - row;
      break;
    case 2:
      nextRow = size - 1 - row;
      nextCol = size - 1 - col;
      break;
    case 3:
      nextRow = size - 1 - col;
      nextCol = row;
      break;
    case 4:
      nextCol = size - 1 - col;
      break;
    case 5:
      nextRow = size - 1 - row;
      break;
    case 6:
      nextRow = col;
      nextCol = row;
      break;
    default:
      nextRow = size - 1 - col;
      nextCol = size - 1 - row;
      break;
  }

  return nextRow * size + nextCol;
}

function isCentralCell(cell: CellIndex, size: SupportedGridSize): boolean {
  const row = Math.floor(cell / size);
  const col = cell % size;

  return row > 0 && row + 1 < size && col > 0 && col + 1 < size;
}

export function generateSolutionPath(
  size: SupportedGridSize,
  random: RandomSource = Math.random,
): CellIndex[] {
  const transform = randomIntInclusive(0, 7, random);
  const path = baseSerpentinePath(size).map((cell) => transformCell(cell, size, transform));

  if (random() < 0.5) path.reverse();
  randomizePath(path, size, random);

  return path;
}

function canSkipSegment(
  path: readonly CellIndex[],
  index: number,
  length: number,
  size: SupportedGridSize,
): boolean {
  if (index <= 0 || index + length >= path.length) return false;

  const previous = path[index - 1];
  const next = path[index + length];

  return neighborsOf(previous, size).includes(next);
}

export function carveDeadCells(
  path: CellIndex[],
  size: SupportedGridSize,
  random: RandomSource = Math.random,
): CellIndex[] {
  if (random() < 0.5) return [];

  const segmentLength = 2;
  const targetCount = randomIntInclusive(1, Math.max(1, Math.floor(size / 3)), random) * segmentLength;
  const deadCells: CellIndex[] = [];
  let attemptsWithoutRemoval = 0;

  while (deadCells.length < targetCount && attemptsWithoutRemoval < path.length * 3) {
    const index = randomIntInclusive(1, path.length - segmentLength - 1, random);
    if (!canSkipSegment(path, index, segmentLength, size)) {
      attemptsWithoutRemoval += 1;
      continue;
    }

    deadCells.push(...path.splice(index, segmentLength));
    attemptsWithoutRemoval = 0;
  }

  return deadCells;
}

export function chooseAnchors(
  path: readonly CellIndex[],
  requestedCount: number,
  random: RandomSource = Math.random,
): AnchorMap {
  const count = Math.min(path.length, Math.max(2, Math.trunc(requestedCount)));
  const offsets = new Set<number>([0, path.length - 1]);

  while (offsets.size < count) {
    offsets.add(Math.floor(random() * path.length));
  }

  return Array.from(offsets)
    .sort((a, b) => a - b)
    .reduce<AnchorMap>((map, offset, index) => {
      const cell = path[offset];
      if (cell !== undefined) map[cell] = index + 1;
      return map;
    }, {});
}

export function generateBarriers(
  path: readonly CellIndex[],
  size: SupportedGridSize,
  deadCells: readonly CellIndex[] = [],
  random: RandomSource = Math.random,
): BarrierEdge[] {
  if (random() < 0.45) return [];
  const solutionEdges = new Set<string>();
  for (let index = 1; index < path.length; index += 1) {
    solutionEdges.add(edgeKey(path[index - 1], path[index]));
  }
  const deadSet = new Set(deadCells);

  const candidates: BarrierEdge[] = [];
  for (let cell = 0; cell < size * size; cell += 1) {
    if (deadSet.has(cell) || !isCentralCell(cell, size)) continue;

    const right = cell + 1;
    if (!deadSet.has(right) && cell % size + 1 < size && isCentralCell(right, size) && !solutionEdges.has(edgeKey(cell, right))) {
      candidates.push({ from: cell, to: right });
    }

    const down = cell + size;
    if (!deadSet.has(down) && down < size * size && isCentralCell(down, size) && !solutionEdges.has(edgeKey(cell, down))) {
      candidates.push({ from: cell, to: down });
    }
  }

  const targetCount = Math.min(candidates.length, randomIntInclusive(Math.max(2, size - 3), size + 2, random));
  const barriers: BarrierEdge[] = [];

  while (barriers.length < targetCount && candidates.length > 0) {
    const index = randomIntInclusive(0, candidates.length - 1, random);
    const [barrier] = candidates.splice(index, 1);
    if (barrier) barriers.push(barrier);
  }

  return barriers;
}

export function generatePuzzle(config: PuzzleConfig = generateRandomPuzzleConfig()): GeneratedPuzzle {
  validatePuzzleConfig(config);

  const seed = config.seed ?? randomSeed();
  const random = createSeededRandom(seed);
  const solutionPath = generateSolutionPath(config.size, random);
  const deadCells = carveDeadCells(solutionPath, config.size, random);

  return {
    ...config,
    seed,
    solutionPath,
    anchors: chooseAnchors(solutionPath, config.anchorCount, random),
    barriers: generateBarriers(solutionPath, config.size, deadCells, random),
    deadCells,
  };
}

/* ------------------------------------------------------------------ */
/*  Validation & Solving logic for Game Server                         */
/* ------------------------------------------------------------------ */

export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

export function getFirstAnchor(puzzle: GeneratedPuzzle): CellIndex {
  for (const [cellStr, order] of Object.entries(puzzle.anchors)) {
    if (order === 1) return parseInt(cellStr, 10);
  }
  return puzzle.solutionPath[0];
}

export function validateMove(
  currentPath: CellIndex[],
  nextCell: CellIndex,
  puzzle: GeneratedPuzzle,
): ValidationResult {
  const { size, anchors, barriers, deadCells } = puzzle;

  if (nextCell < 0 || nextCell >= size * size) {
    return { valid: false, reason: "Cell is out of bounds" };
  }

  if (currentPath.length === 0) {
    return { valid: false, reason: "Path is empty" };
  }

  const head = currentPath[currentPath.length - 1];

  const headRow = Math.floor(head / size);
  const headCol = head % size;
  const nextRow = Math.floor(nextCell / size);
  const nextCol = nextCell % size;

  if (Math.abs(headRow - nextRow) + Math.abs(headCol - nextCol) !== 1) {
    return { valid: false, reason: "Cell is not orthogonally adjacent" };
  }

  if (deadCells.includes(nextCell)) {
    return { valid: false, reason: "Cell is a dead cell" };
  }

  if (currentPath.includes(nextCell)) {
    return { valid: false, reason: "Cell already visited" };
  }

  const edge = edgeKey(head, nextCell);
  for (const b of barriers) {
    if (edgeKey(b.from, b.to) === edge) {
      return { valid: false, reason: "A barrier blocks this move" };
    }
  }

  let nextExpectedAnchor = 1;
  for (const cell of currentPath) {
    if (anchors[cell] === nextExpectedAnchor) {
      nextExpectedAnchor++;
    }
  }

  if (anchors[nextCell] !== undefined && anchors[nextCell] !== nextExpectedAnchor) {
    return { valid: false, reason: "Anchor visited out of order" };
  }

  return { valid: true };
}

export function validateCompletePath(
  path: CellIndex[],
  puzzle: GeneratedPuzzle,
): ValidationResult {
  const { size, deadCells, anchors } = puzzle;
  const totalValidCells = size * size - deadCells.length;

  if (path.length !== totalValidCells) {
    return { valid: false, reason: "Path does not cover all available cells" };
  }

  if (path.length > 0) {
    if (anchors[path[0]] !== 1) {
      return { valid: false, reason: "Path must start at the first anchor" };
    }

    let nextExpectedAnchor = 1;
    for (let i = 0; i < path.length; i++) {
      if (i > 0) {
        const cur = path[i];
        const res = validateMove(path.slice(0, i), cur, puzzle);
        if (!res.valid) return res;
      }
      if (anchors[path[i]] === nextExpectedAnchor) {
        nextExpectedAnchor++;
      }
    }

    if (nextExpectedAnchor - 1 !== Object.keys(anchors).length) {
      return { valid: false, reason: "Not all anchors visited" };
    }
  }

  return { valid: true };
}

export function solveForHint(
  puzzle: GeneratedPuzzle,
  currentPath: CellIndex[]
): { validPrefix: CellIndex[]; nextCell: CellIndex } | null {
  // To keep hint solving fast and robust for the 1D backbite algorithm without DFS,
  // we align the player's path with the generated solution path.
  let matchLen = 0;
  while (
    matchLen < currentPath.length &&
    matchLen < puzzle.solutionPath.length &&
    currentPath[matchLen] === puzzle.solutionPath[matchLen]
  ) {
    matchLen++;
  }

  if (matchLen === 0) {
    return { validPrefix: [], nextCell: puzzle.solutionPath[0] };
  }

  if (matchLen < puzzle.solutionPath.length) {
    return {
      validPrefix: puzzle.solutionPath.slice(0, matchLen),
      nextCell: puzzle.solutionPath[matchLen],
    };
  }

  return null;
}
