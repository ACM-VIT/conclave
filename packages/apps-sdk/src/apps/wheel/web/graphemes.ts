const EXTENDS_CLUSTER =
  /^(?:\p{M}|[\u200C\u200D\u0E33\u0EB3\uFF9E\uFF9F]|[\u{1F3FB}-\u{1F3FF}]|[\u{E0020}-\u{E007F}])$/u;
const STANDALONE_SPACING_MARK =
  /^[\u102B\u102C\u1038\u1062-\u1064\u1067-\u106D\u1083\u1087-\u108C\u108F\u109A-\u109C\u1A61\u1A63\u1A64\uAA7B\uAA7D\u{11720}\u{11721}]$/u;
const EXTENDING_SPACING_MARK =
  /^[\u09BE\u09D7\u0B3E\u0B57\u0BBE\u0BD7\u0CC0\u0CC2\u0CC7\u0CC8\u0CCA\u0CCB\u0CD5\u0CD6\u0D3E\u0D57\u0DCF\u0DDF\u1715\u1734\u1B35\u1B3B\u1B3D\u1B43\u1BAA\u1BF2\u1BF3\u302E\u302F\uA953\u{111C0}\u{11235}\u{1133E}\u{1134D}\u{11357}\u{113B8}\u{113C2}\u{113C5}\u{113C7}-\u{113C9}\u{113CF}\u{114B0}\u{114BD}\u{115AF}\u{116B6}\u{11930}\u{1193D}\u{11F41}\u{16FF0}\u{16FF1}\u{1D165}\u{1D166}\u{1D16D}-\u{1D172}]$/u;
const SPACING_MARK = /^[\p{Mc}\u0E33\u0EB3]$/u;
const CONTROL = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]$/u;
const UNASSIGNED_IGNORABLE = /^(?=\p{Cn})\p{Default_Ignorable_Code_Point}$/u;
const NOT_CONTROL = /^[\u200C\u200D\u{E0020}-\u{E007F}]$/u;
const PREPEND =
  /^[\u0600-\u0605\u06DD\u070F\u0890\u0891\u08E2\u0D4E\u{110BD}\u{110CD}\u{111C2}\u{111C3}\u{113D1}\u{1193F}\u{11941}\u{11A84}-\u{11A89}\u{11D46}\u{11F02}]$/u;
const REGIONAL_INDICATOR = /^[\u{1F1E6}-\u{1F1FF}]$/u;
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;

const CONJUNCT_SCRIPTS: Record<string, { linker: string; consonants: string }> = {
  devanagari: { linker: "\u094D", consonants: "\u0915-\u0939\u0958-\u095F\u0978-\u097F" },
  bengali: {
    linker: "\u09CD",
    consonants: "\u0995-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09DC\u09DD\u09DF\u09F0\u09F1",
  },
  gujarati: { linker: "\u0ACD", consonants: "\u0A95-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0AF9" },
  oriya: {
    linker: "\u0B4D",
    consonants: "\u0B15-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B5C\u0B5D\u0B5F\u0B71",
  },
  telugu: { linker: "\u0C4D", consonants: "\u0C15-\u0C28\u0C2A-\u0C39\u0C58-\u0C5A" },
  malayalam: { linker: "\u0D4D", consonants: "\u0D15-\u0D3A" },
  myanmar: {
    linker: "\u1039",
    consonants:
      "\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\uA9E0-\uA9E4\uA9E7-\uA9EF\uA9FA-\uA9FE\uAA60-\uAA6F\uAA71-\uAA73\uAA7A\uAA7E\uAA7F",
  },
  khmer: { linker: "\u17D2", consonants: "\u1780-\u17B3" },
  taiTham: { linker: "\u1A60", consonants: "\u1A20-\u1A54" },
  balinese: { linker: "\u1B44", consonants: "\u1B0B\u1B0C\u1B13-\u1B33\u1B45-\u1B4C" },
  sundanese: { linker: "\u1BAB", consonants: "\u1B83-\u1BA0\u1BAE\u1BAF\u1BBB-\u1BBD" },
  javanese: { linker: "\uA9C0", consonants: "\uA989-\uA98B\uA98F-\uA9B2" },
  meeteiMayek: { linker: "\uAAF6", consonants: "\uAAE0-\uAAEA\uABC0-\uABDA" },
  kharoshthi: { linker: "\u{10A3F}", consonants: "\u{10A00}\u{10A10}-\u{10A13}\u{10A15}-\u{10A17}\u{10A19}-\u{10A35}" },
  chakma: { linker: "\u{11133}", consonants: "\u{11103}-\u{11126}\u{11144}\u{11147}" },
  tuluTigalari: { linker: "\u{113D0}", consonants: "\u{11380}-\u{11389}\u{1138B}\u{1138E}\u{11390}-\u{113B5}" },
  divesAkuru: {
    linker: "\u{1193E}",
    consonants: "\u{11900}-\u{11906}\u{11909}\u{1190C}-\u{11913}\u{11915}\u{11916}\u{11918}-\u{1192F}",
  },
  zanabazarSquare: { linker: "\u{11A47}", consonants: "\u{11A00}\u{11A0B}-\u{11A32}" },
  soyombo: { linker: "\u{11A99}", consonants: "\u{11A50}\u{11A5C}-\u{11A83}" },
  kawi: { linker: "\u{11F42}", consonants: "\u{11F04}-\u{11F10}\u{11F12}-\u{11F33}" },
};

const characterClass = (parts: string[]): RegExp => new RegExp(`^[${parts.join("")}]$`, "u");
const conjunctScripts = Object.values(CONJUNCT_SCRIPTS);
const CONJUNCT_LINKER = characterClass(conjunctScripts.map((script) => script.linker));
const CONJUNCT_CONSONANT = characterClass(conjunctScripts.map((script) => script.consonants));

type HangulPart = "L" | "V" | "T" | "LV" | "LVT";

const hangulPart = (point: string): HangulPart | null => {
  const code = point.codePointAt(0) ?? 0;
  if ((code >= 0x1100 && code <= 0x115f) || (code >= 0xa960 && code <= 0xa97c)) return "L";
  if (
    (code >= 0x1160 && code <= 0x11a7) ||
    (code >= 0xd7b0 && code <= 0xd7c6) ||
    code === 0x16d63 ||
    (code >= 0x16d67 && code <= 0x16d6a)
  ) {
    return "V";
  }
  if ((code >= 0x11a8 && code <= 0x11ff) || (code >= 0xd7cb && code <= 0xd7fb)) return "T";
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? "LV" : "LVT";
  return null;
};

const joinsHangul = (before: HangulPart, after: HangulPart): boolean =>
  before === "L"
    ? after !== "T"
    : before === "LV" || before === "V"
      ? after === "V" || after === "T"
      : after === "T";

type Conjunct = "none" | "consonant" | "linked";

type ClusterState = {
  closed: boolean;
  prependOpen: boolean;
  pictographicTail: boolean;
  afterJoiner: boolean;
  flagOpen: boolean;
  hangul: HangulPart | null;
  conjunct: Conjunct;
};

const isControl = (point: string): boolean =>
  (CONTROL.test(point) || UNASSIGNED_IGNORABLE.test(point)) &&
  !NOT_CONTROL.test(point) &&
  !PREPEND.test(point);

const extendsCluster = (point: string): boolean =>
  (EXTENDS_CLUSTER.test(point) || CONJUNCT_LINKER.test(point) || EXTENDING_SPACING_MARK.test(point)) &&
  !STANDALONE_SPACING_MARK.test(point);

const isSpacingMark = (point: string): boolean =>
  SPACING_MARK.test(point) && !EXTENDING_SPACING_MARK.test(point) && !CONJUNCT_LINKER.test(point);

const conjunctAfterMark = (conjunct: Conjunct, point: string): Conjunct => {
  if (conjunct === "none") return "none";
  if (CONJUNCT_LINKER.test(point)) return "linked";
  return point === "\u200C" || isSpacingMark(point) ? "none" : conjunct;
};

const clusterFrom = (point: string, part: HangulPart | null, control: boolean): ClusterState => ({
  closed: control,
  prependOpen: PREPEND.test(point),
  pictographicTail: PICTOGRAPHIC.test(point),
  afterJoiner: false,
  flagOpen: REGIONAL_INDICATOR.test(point),
  hangul: part,
  conjunct: CONJUNCT_CONSONANT.test(point) ? "consonant" : "none",
});

const joinsCluster = (state: ClusterState, point: string, part: HangulPart | null): boolean => {
  if (state.afterJoiner && PICTOGRAPHIC.test(point)) {
    state.afterJoiner = false;
    state.pictographicTail = true;
    state.conjunct = "none";
    return true;
  }
  if (extendsCluster(point)) {
    const joiner = point === "\u200D";
    state.afterJoiner = joiner && state.pictographicTail;
    if (joiner || isSpacingMark(point)) state.pictographicTail = false;
    state.flagOpen = false;
    state.hangul = null;
    state.conjunct = conjunctAfterMark(state.conjunct, point);
    return true;
  }
  if (state.conjunct === "linked" && CONJUNCT_CONSONANT.test(point)) {
    state.conjunct = "consonant";
    return true;
  }
  if (state.flagOpen && REGIONAL_INDICATOR.test(point)) {
    state.flagOpen = false;
    return true;
  }
  if (state.hangul && part && joinsHangul(state.hangul, part)) {
    state.hangul = part;
    return true;
  }
  return false;
};

export const splitGraphemesFallback = (text: string): string[] => {
  const clusters: string[] = [];
  let state: ClusterState | null = null;
  for (const point of text) {
    const last = clusters.length - 1;
    const part = hangulPart(point);
    const control = isControl(point);
    if (state && control && point === "\n" && clusters[last] === "\r") {
      clusters[last] += point;
      continue;
    }
    if (state && !control && !state.closed) {
      if (state.prependOpen) {
        clusters[last] += point;
        state = clusterFrom(point, part, false);
        continue;
      }
      if (joinsCluster(state, point, part)) {
        clusters[last] += point;
        continue;
      }
    }
    clusters.push(point);
    state = clusterFrom(point, part, control);
  }
  return clusters;
};

const SEGMENTER_PROBES: readonly (readonly [string, number])[] = [
  ["\u0915\u094D\u0937", 1],
  ["\u0995\u09CD\u09B7", 1],
  ["\u1001\u1014\u1039\u1013\u102C", 3],
  ["\u1021\u1004\u103A\u1039\u1002", 2],
  ["\u1019\u103C\u1014\u103A", 2],
  ["\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", 1],
  ["\u0600\u0661", 1],
];

const trustedSegmenter = (): Intl.Segmenter | null => {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") return null;
  try {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const correct = SEGMENTER_PROBES.every(
      ([text, clusters]) => Array.from(segmenter.segment(text)).length === clusters
    );
    return correct ? segmenter : null;
  } catch {
    return null;
  }
};

const graphemeSegmenter = trustedSegmenter();

export const graphemes = (text: string): string[] =>
  graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(text), (part) => part.segment)
    : splitGraphemesFallback(text);
