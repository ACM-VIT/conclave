import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Loading lives outside modules/ so the game module itself stays a pure
// reducer (no runtime imports outside the games runtime — see README).
const gamesDir = dirname(fileURLToPath(import.meta.url));
const wordsPath = resolve(gamesDir, "modules", "wordleWords.txt");

const loadWordList = (): string[] => {
  let fileContents: string;
  try {
    fileContents = readFileSync(wordsPath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load Wordle word list at ${wordsPath}: ${reason}`);
  }

  const words = fileContents
    .split("\n")
    .map((word) => word.trim().toUpperCase())
    .filter((word) => /^[A-Z]{5}$/.test(word));

  if (words.length === 0) {
    throw new Error(`Wordle word list at ${wordsPath} did not contain any 5-letter words`);
  }

  return words;
};

/** All valid 5-letter words, loaded once at startup; throws if missing. */
export const WORDLE_WORDS: readonly string[] = loadWordList();
