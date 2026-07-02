// Loader for the Conclave brand animation.
//
// The asset ships as a .lottie (a ~1.3MB zip of a small JSON + 301 WebP frame
// images) instead of the ~6.6MB inlined JSON — much smaller to download. But it
// is a video-to-lottie (raster frames), which the dotLottie/ThorVG WASM engine
// can't render, so we unzip it in the browser and inline the frames back into
// the JSON as data URIs for the proven lottie-web canvas renderer. Done once and
// cached module-wide.

import { strFromU8, unzipSync } from "fflate";

const ANIMATION_URL = "/conclave-animation.lottie";

let cached: Promise<Record<string, unknown>> | null = null;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function buildAnimation(): Promise<Record<string, unknown>> {
  const res = await fetch(ANIMATION_URL);
  if (!res.ok) throw new Error(`conclave animation ${res.status}`);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));

  const manifest = JSON.parse(strFromU8(files["manifest.json"])) as {
    animations?: { id?: string }[];
  };
  const id = manifest.animations?.[0]?.id;
  const animFile = id ? files[`animations/${id}.json`] : undefined;
  if (!animFile) throw new Error("conclave animation: missing animation entry");

  const anim = JSON.parse(strFromU8(animFile)) as {
    assets?: { p?: string; u?: string; e?: number }[];
  };

  for (const asset of anim.assets ?? []) {
    if (!asset || typeof asset.p !== "string" || asset.p.startsWith("data:")) {
      continue;
    }
    const bytes = files[`images/${asset.p}`];
    if (!bytes) continue;
    asset.p = `data:image/webp;base64,${toBase64(bytes)}`;
    asset.u = "";
    asset.e = 1;
  }

  return anim;
}

export function loadConclaveAnimation(): Promise<Record<string, unknown>> {
  if (!cached) {
    cached = buildAnimation().catch((err) => {
      cached = null; // allow a later retry
      throw err;
    });
  }
  return cached;
}

// Warm the cache (download + unzip + inline) while the lobby is idle so the
// overlay can paint the animation the instant the user commits to a meeting.
export function prefetchConclaveAnimation(): void {
  void loadConclaveAnimation().catch(() => {});
}
