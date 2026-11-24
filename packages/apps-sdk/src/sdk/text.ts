import { withoutLoneSurrogates } from "#native-embed/protocol";
import { graphemes } from "#sdk/graphemes";

export const cutText = (text: string, limit: number): string => {
  const whole = withoutLoneSurrogates(text);
  if (whole.length <= limit) return whole;
  let kept = "";
  for (const cluster of graphemes(whole.slice(0, limit + 2))) {
    if (kept.length + cluster.length > limit) break;
    kept += cluster;
  }
  if (kept === "") {
    for (const point of whole) {
      if (kept.length + point.length > limit) break;
      kept += point;
    }
  }
  return kept.trimEnd();
};
