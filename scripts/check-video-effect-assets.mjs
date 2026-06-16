import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const webPublicDir = path.join(repoRoot, "apps/web/public");
const effectsSourcePath = path.join(
  repoRoot,
  "apps/web/src/app/lib/video-effects.ts",
);

const expectedGeneratedBackgrounds = [
  "camper-vacation",
  "dog-office",
  "indian-balcony",
  "arabian-cafe-terrace",
  "ocean-terrace",
  "snowy-cafe",
];
const allowedNoAssetBackgrounds = new Set([
  "none",
  "blur-light",
  "blur-strong",
  "custom",
]);

const source = fs.readFileSync(effectsSourcePath, "utf8");

const fail = (message, details = undefined) => {
  console.error(`video effect asset check failed: ${message}`);
  if (details) console.error(JSON.stringify(details, null, 2));
  process.exitCode = 1;
};

const findBalanced = (text, openIndex, openChar, closeChar) => {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === openChar) {
      depth += 1;
    } else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex, index + 1);
    }
  }

  throw new Error(`could not find balanced ${openChar}${closeChar}`);
};

const extractConstBlock = (name, openChar, closeChar) => {
  const marker = `export const ${name}`;
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) throw new Error(`missing ${name}`);
  const assignmentIndex = source.indexOf("=", markerIndex);
  if (assignmentIndex === -1) throw new Error(`missing assignment for ${name}`);
  const openIndex = source.indexOf(openChar, assignmentIndex);
  if (openIndex === -1) throw new Error(`missing ${openChar} for ${name}`);
  return findBalanced(source, openIndex, openChar, closeChar);
};

const assetPathBlock = extractConstBlock(
  "BACKGROUND_ASSET_PATHS",
  "{",
  "}",
);
const backgroundEffectsBlock = extractConstBlock(
  "BACKGROUND_EFFECTS",
  "[",
  "]",
);

const assetPaths = new Map();
const assetPathEntryPattern =
  /(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*"([^"]+)"/g;
let assetPathMatch = null;
while ((assetPathMatch = assetPathEntryPattern.exec(assetPathBlock))) {
  assetPaths.set(assetPathMatch[1] ?? assetPathMatch[2], assetPathMatch[3]);
}

const effectObjects = [];
for (let index = 0; index < backgroundEffectsBlock.length; index += 1) {
  if (backgroundEffectsBlock[index] !== "{") continue;
  const objectText = findBalanced(backgroundEffectsBlock, index, "{", "}");
  effectObjects.push(objectText);
  index += objectText.length - 1;
}

const backgroundOptions = effectObjects
  .map((objectText) => {
    const id = objectText.match(/\bid:\s*"([^"]+)"/)?.[1] ?? null;
    const label = objectText.match(/\blabel:\s*"([^"]+)"/)?.[1] ?? null;
    const assetPathMatch = objectText.match(
      /\bassetPath:\s*BACKGROUND_ASSET_PATHS(?:\["([^"]+)"\]|\.([A-Za-z_$][\w$]*))/,
    );
    const assetKey = assetPathMatch
      ? assetPathMatch[1] ?? assetPathMatch[2]
      : null;
    const assetPath = assetKey ? assetPaths.get(assetKey) ?? null : null;
    return { id, label, assetKey, assetPath };
  })
  .filter((option) => option.id && option.label);

const usedAssetKeys = new Set();
const usedBackgroundFiles = new Set();
const noAssetBackgrounds = [];
const missingAssets = [];
const missingThumbnails = [];

for (const option of backgroundOptions) {
  if (!option.assetKey) {
    if (!allowedNoAssetBackgrounds.has(option.id)) {
      noAssetBackgrounds.push({
        id: option.id,
        label: option.label,
      });
    }
    continue;
  }
  usedAssetKeys.add(option.assetKey);
  if (!option.assetPath) {
    missingAssets.push({
      id: option.id,
      label: option.label,
      assetKey: option.assetKey,
      reason: "missing BACKGROUND_ASSET_PATHS entry",
    });
    continue;
  }

  const publicAssetPath = path.join(webPublicDir, option.assetPath);
  const thumbnailPath = option.assetPath.replace(
    "/effects/backgrounds/",
    "/effects/background-thumbnails/",
  );
  const publicThumbnailPath = path.join(webPublicDir, thumbnailPath);
  usedBackgroundFiles.add(path.basename(option.assetPath));

  if (!fs.existsSync(publicAssetPath)) {
    missingAssets.push({
      id: option.id,
      label: option.label,
      assetPath: option.assetPath,
    });
  }

  if (!fs.existsSync(publicThumbnailPath)) {
    missingThumbnails.push({
      id: option.id,
      label: option.label,
      thumbnailPath,
    });
  }
}

const unusedAssetKeys = [...assetPaths.keys()].filter(
  (assetKey) => !usedAssetKeys.has(assetKey),
);
const backgroundDir = path.join(webPublicDir, "effects/backgrounds");
const thumbnailDir = path.join(webPublicDir, "effects/background-thumbnails");
const backgroundFiles = fs
  .readdirSync(backgroundDir)
  .filter((fileName) => fileName.endsWith(".webp"))
  .sort();
const thumbnailFiles = fs
  .readdirSync(thumbnailDir)
  .filter((fileName) => fileName.endsWith(".webp"))
  .sort();
const unusedBackgroundFiles = backgroundFiles.filter(
  (fileName) => !usedBackgroundFiles.has(fileName),
);
const missingMatchingThumbnails = backgroundFiles.filter(
  (fileName) => !thumbnailFiles.includes(fileName),
);
const staleThumbnails = thumbnailFiles.filter(
  (fileName) => !backgroundFiles.includes(fileName),
);

const optionById = new Map(
  backgroundOptions.map((option) => [option.id, option]),
);
const generatedMappingProblems = expectedGeneratedBackgrounds.flatMap((id) => {
  const option = optionById.get(id);
  if (!option) return [{ id, reason: "missing background option" }];
  const expectedAssetPath = `/effects/backgrounds/${id}.webp`;
  if (option.assetKey !== id || option.assetPath !== expectedAssetPath) {
    return [
      {
        id,
        label: option.label,
        assetKey: option.assetKey,
        assetPath: option.assetPath,
        expectedAssetPath,
      },
    ];
  }
  return [];
});

if (missingAssets.length) fail("missing background assets", missingAssets);
if (missingThumbnails.length) {
  fail("missing background thumbnails", missingThumbnails);
}
if (noAssetBackgrounds.length) {
  fail("visible backgrounds without raster assets", noAssetBackgrounds);
}
if (missingMatchingThumbnails.length) {
  fail("background files missing matching thumbnails", missingMatchingThumbnails);
}
if (staleThumbnails.length) {
  fail("thumbnail files without matching backgrounds", staleThumbnails);
}
if (generatedMappingProblems.length) {
  fail("generated backgrounds are not wired to matching options", generatedMappingProblems);
}

if (!process.exitCode) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        backgroundOptionCount: backgroundOptions.length,
        imageBackedOptionCount: backgroundOptions.filter(
          (option) => option.assetKey,
        ).length,
        backgroundFileCount: backgroundFiles.length,
        generatedBackgrounds: expectedGeneratedBackgrounds,
        hiddenAssetKeyCount: unusedAssetKeys.length,
        hiddenBackgroundFileCount: unusedBackgroundFiles.length,
      },
      null,
      2,
    ),
  );
}
