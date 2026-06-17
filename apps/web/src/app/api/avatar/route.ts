import { toFacehashHandler } from "facehash/next";

export const { GET } = toFacehashHandler({
  colors: [
    "#F95F4A",
    "#FF007A",
    "#7C5CFF",
    "#2DA8A8",
    "#4F86F7",
    "#3FA66A",
    "#F59E0B",
    "#14B8A6",
    "#E879F9",
    "#38BDF8",
  ],
  showInitial: false,
  variant: "gradient",
});
