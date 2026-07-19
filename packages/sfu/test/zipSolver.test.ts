import { describe, expect, it } from "vitest";
import {
  generatePuzzle,
  validateMove,
  validateCompletePath,
  solveForHint,
  type GeneratedPuzzle,
} from "../server/games/modules/zipSolver.js";

describe("zipSolver", () => {
  describe("puzzle variation", () => {
    it("produces different layouts for independently seeded starts", () => {
      const signatures = new Set(
        [101, 202, 303, 404].map((seed) => {
          const puzzle = generatePuzzle({ size: 6, anchorCount: 8, seed });
          return JSON.stringify({
            anchors: puzzle.anchors,
            barriers: puzzle.barriers,
            solutionPath: puzzle.solutionPath,
          });
        }),
      );

      expect(signatures.size).toBe(4);
    });

    it("creates a valid complete path at every supported grid size", () => {
      for (const size of [6, 7, 8, 9] as const) {
        const puzzle = generatePuzzle({
          size,
          anchorCount: { 6: 8, 7: 10, 8: 12, 9: 14 }[size],
          seed: size,
        });
        expect(validateCompletePath(puzzle.solutionPath, puzzle).valid).toBe(true);
      }
    });
  });

  describe("validateMove", () => {
    const puzzle: GeneratedPuzzle = {
      size: 6,
      anchorCount: 3,
      seed: 123,
      solutionPath: [0, 1, 2, 8, 14, 15],
      anchors: {
        0: 1,
        2: 2,
        15: 3,
      },
      barriers: [{ from: 1, to: 7 }],
      deadCells: [7],
    };

    it("accepts valid orthogonal move", () => {
      const result = validateMove([0], 1, puzzle);
      expect(result.valid).toBe(true);
    });

    it("rejects diagonal move", () => {
      const result = validateMove([0], 7, puzzle);
      expect(result.valid).toBe(false);
      expect(result.valid === false && result.reason).toContain("adjacent");
    });

    it("rejects wall/barrier crossing", () => {
      // Barrier is 1 -> 7 (but 7 is dead anyway)
      const result = validateMove([1], 7, puzzle);
      expect(result.valid).toBe(false);
      expect(result.valid === false && result.reason).toContain("dead cell");
    });

    it("rejects revisiting a cell", () => {
      const result = validateMove([0, 1], 0, puzzle);
      expect(result.valid).toBe(false);
      expect(result.valid === false && result.reason).toContain("visited");
    });

    it("rejects out-of-order anchor", () => {
      // Expected anchor is 2 (at cell 2), visiting 15 first
      const result = validateMove([0, 6, 12, 13, 14], 15, puzzle);
      expect(result.valid).toBe(false);
      expect(result.valid === false && result.reason).toContain("order");
    });
  });

  describe("validateCompletePath", () => {
    it("accepts a valid complete path", () => {
      const puzzle = generatePuzzle({ size: 6, anchorCount: 8, seed: 123 });
      const path = puzzle.solutionPath;
      const result = validateCompletePath(path, puzzle);
      expect(result.valid).toBe(true);
    });

    it("rejects an incomplete path", () => {
      const puzzle = generatePuzzle({ size: 6, anchorCount: 8, seed: 123 });
      const path = puzzle.solutionPath.slice(0, -1);
      const result = validateCompletePath(path, puzzle);
      expect(result.valid).toBe(false);
      expect(result.valid === false && result.reason).toContain("cover all available cells");
    });
  });

  describe("solveForHint", () => {
    it("returns the next correct cell from a valid prefix matching solutionPath", () => {
      const puzzle = generatePuzzle({ size: 6, anchorCount: 8, seed: 123 });
      const path = puzzle.solutionPath;

      const hint = solveForHint(puzzle, [path[0]]);
      expect(hint).not.toBeNull();
      if (hint) {
        expect(hint.validPrefix).toEqual([path[0]]);
        expect(hint.nextCell).toBe(path[1]);
      }
    });

    it("trims back an invalid prefix before hinting", () => {
      const puzzle = generatePuzzle({ size: 6, anchorCount: 8, seed: 123 });
      const path = puzzle.solutionPath;

      // Make an invalid path: start correctly, then deviate to something wrong
      const invalidPath = [path[0], path[1], path[0]];
      const hint = solveForHint(puzzle, invalidPath);

      expect(hint).not.toBeNull();
      if (hint) {
        expect(hint.validPrefix.length).toBe(2);
        expect(hint.validPrefix).toEqual([path[0], path[1]]);
        expect(hint.nextCell).toBe(path[2]);
      }
    });
  });
});
