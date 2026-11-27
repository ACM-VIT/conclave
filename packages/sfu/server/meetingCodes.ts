import { randomInt } from "node:crypto";

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const GROUP_LENGTHS = [3, 4, 3];

// The same "abc-mnop-xyz" format the web uses for new meetings: 26^10
// possible codes, so scheduled rooms cannot be found by guessing either.
export const generateMeetingCode = (): string =>
  GROUP_LENGTHS.map((length) =>
    Array.from({ length }, () => LETTERS[randomInt(LETTERS.length)]).join(""),
  ).join("-");
