import assert from "node:assert/strict";
import test from "node:test";
import { createVisualMetricToolkit } from "./visual-metrics.mjs";

const image = (width, height, pixel) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = pixel(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = red;
      data[offset + 1] = green;
      data[offset + 2] = blue;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
};

test("five-level MS-SSIM and BT.709 chroma are perfect for identical frames", () => {
  const metrics = createVisualMetricToolkit();
  const source = image(80, 48, (x, y) => [x * 3, y * 5, (x + y) * 2]);
  const result = metrics.compareImages(source, source);

  assert.equal(result.multiScaleLevels.length, 5);
  assert.equal(result.ssim, 1);
  assert.equal(result.multiScaleSsim, 1);
  assert.equal(result.chromaSsim, 1);
  assert.equal(result.psnrDb, 100);
  assert.equal(result.chromaPsnrDb, 100);
});

test("equal-luminance hue corruption is caught by chroma evidence", () => {
  const metrics = createVisualMetricToolkit();
  const red = image(64, 48, () => [255, 0, 0]);
  // 76 green has approximately the same Rec.709 luma as full red.
  const green = image(64, 48, () => [0, 76, 0]);
  const result = metrics.compareImages(green, red);

  assert.ok(result.meanAbsoluteLumaError < 0.2);
  assert.ok(result.chromaPsnrDb < 10);
  assert.ok(result.chromaSsim < 0.9);
});

test("fine-detail damage remains visible across the true multiscale pyramid", () => {
  const metrics = createVisualMetricToolkit();
  const detail = image(160, 96, (x, y) =>
    (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0
      ? [245, 245, 245]
      : [10, 10, 10],
  );
  const blurred = image(160, 96, () => [128, 128, 128]);
  const result = metrics.compareImages(blurred, detail);

  assert.equal(result.multiScaleLevels.length, 5);
  assert.ok(result.ssim < 0.1);
  assert.ok(result.multiScaleSsim < 0.8);
  assert.ok(result.edgeRetention < 0.1);
});

test("the 2-D marker mask excludes only marker pixels", () => {
  const maskFactory = (width, height) => {
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 8; x < 40; x += 1) mask[y * width + x] = 1;
    }
    return mask;
  };
  const metrics = createVisualMetricToolkit({ maskFactory });
  const expected = image(64, 48, (x, y) => [x * 3, y * 4, 120]);
  const actual = image(64, 48, (x, y) =>
    y < 4 && x >= 8 && x < 40 ? [255, 0, 255] : [x * 3, y * 4, 120],
  );
  const result = metrics.compareImages(actual, expected);

  assert.equal(result.ssim, 1);
  assert.equal(result.multiScaleSsim, 1);
  assert.equal(result.chromaSsim, 1);
  assert.equal(result.excludedPixels, 128);
  assert.equal(result.comparedPixels, 64 * 48 - 128);
});

test("motion-weighted alignment rejects an adjacent fixture frame", () => {
  const metrics = createVisualMetricToolkit();
  const frame = (offset) =>
    image(96, 64, (x, y) =>
      x >= 20 + offset && x < 36 + offset && y >= 22 && y < 38
        ? [240, 120, 30]
        : [24, 36, 52],
    );
  const previous = frame(-5);
  const current = frame(0);
  const next = frame(5);
  const aligned = metrics.motionWeightedAlignment({
    actualImage: current,
    currentImage: current,
    previousImage: previous,
    nextImage: next,
  });
  const stale = metrics.motionWeightedAlignment({
    actualImage: previous,
    currentImage: current,
    previousImage: previous,
    nextImage: next,
  });

  assert.equal(aligned.valid, true);
  assert.equal(aligned.currentWins, true);
  assert.ok(aligned.margin > 0);
  assert.equal(stale.currentWins, false);
  assert.ok(stale.margin < 0);
});
