const DEFAULT_MS_SSIM_WEIGHTS = [
  0.0448,
  0.2856,
  0.3001,
  0.2363,
  0.1333,
];

/**
 * Pure visual-metric implementation shared by the injected browser harness
 * and direct Node canary tests. Keep every dependency inside this factory so
 * its source can be serialized into Page.addScriptToEvaluateOnNewDocument.
 */
export function createVisualMetricToolkit({ maskFactory = null } = {}) {
  const clamp = (value, minimum, maximum) =>
    Math.min(maximum, Math.max(minimum, value));
  const round = (value, digits = 6) => {
    if (!Number.isFinite(value)) return null;
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
  };
  const resolveMask = (width, height, providedMask = null) => {
    const mask =
      providedMask ??
      (typeof maskFactory === "function" ? maskFactory(width, height) : null) ??
      new Uint8Array(width * height);
    if (mask.length !== width * height) {
      throw new RangeError("visual metric mask dimensions do not match the frame");
    }
    return mask;
  };

  const lumaPlane = (imageData) => {
    const output = new Float32Array(imageData.width * imageData.height);
    for (let index = 0; index < output.length; index += 1) {
      const offset = index * 4;
      output[index] =
        imageData.data[offset] * 0.2126 +
        imageData.data[offset + 1] * 0.7152 +
        imageData.data[offset + 2] * 0.0722;
    }
    return output;
  };

  const chromaPlanes = (imageData) => {
    const cb = new Float32Array(imageData.width * imageData.height);
    const cr = new Float32Array(imageData.width * imageData.height);
    for (let index = 0; index < cb.length; index += 1) {
      const offset = index * 4;
      const red = imageData.data[offset];
      const green = imageData.data[offset + 1];
      const blue = imageData.data[offset + 2];
      // BT.709 full-range YCbCr. Keeping chroma independent from luma makes
      // equal-luminance hue damage visible to the quality gate.
      cb[index] = 128 - 0.114572 * red - 0.385428 * green + 0.5 * blue;
      cr[index] = 128 + 0.5 * red - 0.454153 * green - 0.045847 * blue;
    }
    return { cb, cr };
  };

  const downsamplePlane2x = (plane, width, height) => {
    const nextWidth = Math.max(1, Math.floor(width / 2));
    const nextHeight = Math.max(1, Math.floor(height / 2));
    const output = new Float32Array(nextWidth * nextHeight);
    for (let y = 0; y < nextHeight; y += 1) {
      for (let x = 0; x < nextWidth; x += 1) {
        const sourceX = x * 2;
        const sourceY = y * 2;
        const sourceX1 = Math.min(width - 1, sourceX + 1);
        const sourceY1 = Math.min(height - 1, sourceY + 1);
        output[y * nextWidth + x] =
          (plane[sourceY * width + sourceX] +
            plane[sourceY * width + sourceX1] +
            plane[sourceY1 * width + sourceX] +
            plane[sourceY1 * width + sourceX1]) /
          4;
      }
    }
    return { plane: output, width: nextWidth, height: nextHeight };
  };

  const downsampleMask2x = (mask, width, height) => {
    const nextWidth = Math.max(1, Math.floor(width / 2));
    const nextHeight = Math.max(1, Math.floor(height / 2));
    const output = new Uint8Array(nextWidth * nextHeight);
    for (let y = 0; y < nextHeight; y += 1) {
      for (let x = 0; x < nextWidth; x += 1) {
        const sourceX = x * 2;
        const sourceY = y * 2;
        const sourceX1 = Math.min(width - 1, sourceX + 1);
        const sourceY1 = Math.min(height - 1, sourceY + 1);
        output[y * nextWidth + x] =
          mask[sourceY * width + sourceX] ||
          mask[sourceY * width + sourceX1] ||
          mask[sourceY1 * width + sourceX] ||
          mask[sourceY1 * width + sourceX1]
            ? 1
            : 0;
      }
    }
    return { mask: output, width: nextWidth, height: nextHeight };
  };

  const computeSsimComponents = (
    actual,
    expected,
    width,
    height,
    providedMask = null,
  ) => {
    if (actual.length !== width * height || expected.length !== width * height) {
      throw new RangeError("SSIM plane dimensions do not match the frame");
    }
    const mask = resolveMask(width, height, providedMask);
    const blockSize = 8;
    const c1 = (0.01 * 255) ** 2;
    const c2 = (0.03 * 255) ** 2;
    let luminanceTotal = 0;
    let contrastStructureTotal = 0;
    let ssimTotal = 0;
    let blocks = 0;
    let comparedPixels = 0;

    for (let top = 0; top < height; top += blockSize) {
      for (let left = 0; left < width; left += blockSize) {
        const bottom = Math.min(height, top + blockSize);
        const right = Math.min(width, left + blockSize);
        let count = 0;
        let actualSum = 0;
        let expectedSum = 0;
        for (let y = top; y < bottom; y += 1) {
          for (let x = left; x < right; x += 1) {
            const index = y * width + x;
            if (mask[index]) continue;
            actualSum += actual[index];
            expectedSum += expected[index];
            count += 1;
          }
        }
        if (count < 4) continue;
        const actualMean = actualSum / count;
        const expectedMean = expectedSum / count;
        let actualVariance = 0;
        let expectedVariance = 0;
        let covariance = 0;
        for (let y = top; y < bottom; y += 1) {
          for (let x = left; x < right; x += 1) {
            const index = y * width + x;
            if (mask[index]) continue;
            const actualDelta = actual[index] - actualMean;
            const expectedDelta = expected[index] - expectedMean;
            actualVariance += actualDelta * actualDelta;
            expectedVariance += expectedDelta * expectedDelta;
            covariance += actualDelta * expectedDelta;
          }
        }
        const divisor = Math.max(1, count - 1);
        actualVariance /= divisor;
        expectedVariance /= divisor;
        covariance /= divisor;
        const luminance =
          (2 * actualMean * expectedMean + c1) /
          (actualMean ** 2 + expectedMean ** 2 + c1);
        const contrastStructure =
          (2 * covariance + c2) /
          (actualVariance + expectedVariance + c2);
        luminanceTotal += clamp(luminance, 0, 1);
        contrastStructureTotal += clamp(contrastStructure, 0, 1);
        ssimTotal += clamp(luminance * contrastStructure, 0, 1);
        blocks += 1;
        comparedPixels += count;
      }
    }

    if (blocks === 0) {
      return {
        luminance: 0,
        contrastStructure: 0,
        ssim: 0,
        blocks: 0,
        comparedPixels: 0,
      };
    }
    return {
      luminance: luminanceTotal / blocks,
      contrastStructure: contrastStructureTotal / blocks,
      ssim: ssimTotal / blocks,
      blocks,
      comparedPixels,
    };
  };

  const computeMultiScaleSsim = (
    actual,
    expected,
    width,
    height,
    providedMask = null,
  ) => {
    const weights = [0.0448, 0.2856, 0.3001, 0.2363, 0.1333];
    let actualLevel = actual;
    let expectedLevel = expected;
    let maskLevel = resolveMask(width, height, providedMask);
    let levelWidth = width;
    let levelHeight = height;
    const levels = [];

    for (let level = 0; level < weights.length; level += 1) {
      const components = computeSsimComponents(
        actualLevel,
        expectedLevel,
        levelWidth,
        levelHeight,
        maskLevel,
      );
      levels.push({
        level,
        width: levelWidth,
        height: levelHeight,
        ...components,
      });
      if (level === weights.length - 1) break;
      const nextActual = downsamplePlane2x(
        actualLevel,
        levelWidth,
        levelHeight,
      );
      const nextExpected = downsamplePlane2x(
        expectedLevel,
        levelWidth,
        levelHeight,
      );
      const nextMask = downsampleMask2x(maskLevel, levelWidth, levelHeight);
      actualLevel = nextActual.plane;
      expectedLevel = nextExpected.plane;
      maskLevel = nextMask.mask;
      levelWidth = nextActual.width;
      levelHeight = nextActual.height;
    }

    let value = 1;
    for (let level = 0; level < levels.length - 1; level += 1) {
      value *= Math.max(1e-9, levels[level].contrastStructure) ** weights[level];
    }
    value *=
      Math.max(1e-9, levels[levels.length - 1].ssim) **
      weights[levels.length - 1];
    return { value: clamp(value, 0, 1), levels };
  };

  const sobelMagnitude = (plane, width, x, y) => {
    const top = (y - 1) * width;
    const middle = y * width;
    const bottom = (y + 1) * width;
    const gx =
      -plane[top + x - 1] +
      plane[top + x + 1] -
      2 * plane[middle + x - 1] +
      2 * plane[middle + x + 1] -
      plane[bottom + x - 1] +
      plane[bottom + x + 1];
    const gy =
      -plane[top + x - 1] -
      2 * plane[top + x] -
      plane[top + x + 1] +
      plane[bottom + x - 1] +
      2 * plane[bottom + x] +
      plane[bottom + x + 1];
    return Math.sqrt(gx * gx + gy * gy);
  };

  const edgeRetention = (actual, expected, width, height, mask) => {
    let retained = 0;
    let expectedTotal = 0;
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        if (
          mask[index] ||
          mask[index - 1] ||
          mask[index + 1] ||
          mask[index - width] ||
          mask[index + width]
        ) {
          continue;
        }
        const expectedMagnitude = sobelMagnitude(expected, width, x, y);
        if (expectedMagnitude < 12) continue;
        const actualMagnitude = sobelMagnitude(actual, width, x, y);
        retained += Math.min(expectedMagnitude, actualMagnitude);
        expectedTotal += expectedMagnitude;
      }
    }
    return expectedTotal > 0 ? clamp(retained / expectedTotal, 0, 1) : 1;
  };

  const rawBlockiness = (plane, width, height, mask) => {
    let boundarySum = 0;
    let boundaryCount = 0;
    let interiorSum = 0;
    let interiorCount = 0;
    for (let y = 1; y < height; y += 1) {
      const boundary = y % 8 === 0;
      const interior = y % 8 === 4;
      if (!boundary && !interior) continue;
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const previous = (y - 1) * width + x;
        if (mask[index] || mask[previous]) continue;
        const difference = Math.abs(plane[index] - plane[previous]);
        if (boundary) {
          boundarySum += difference;
          boundaryCount += 1;
        } else {
          interiorSum += difference;
          interiorCount += 1;
        }
      }
    }
    for (let x = 1; x < width; x += 1) {
      const boundary = x % 8 === 0;
      const interior = x % 8 === 4;
      if (!boundary && !interior) continue;
      for (let y = 0; y < height; y += 1) {
        const index = y * width + x;
        if (mask[index] || mask[index - 1]) continue;
        const difference = Math.abs(plane[index] - plane[index - 1]);
        if (boundary) {
          boundarySum += difference;
          boundaryCount += 1;
        } else {
          interiorSum += difference;
          interiorCount += 1;
        }
      }
    }
    const boundaryMean = boundaryCount > 0 ? boundarySum / boundaryCount : 0;
    const interiorMean = interiorCount > 0 ? interiorSum / interiorCount : 0;
    return Math.max(0, (boundaryMean - interiorMean) / 255);
  };

  const compareImages = (actualImage, expectedImage, providedMask = null) => {
    if (
      actualImage.width !== expectedImage.width ||
      actualImage.height !== expectedImage.height
    ) {
      throw new RangeError("visual metric frames must have identical dimensions");
    }
    const width = actualImage.width;
    const height = actualImage.height;
    const mask = resolveMask(width, height, providedMask);
    const actual = lumaPlane(actualImage);
    const expected = lumaPlane(expectedImage);
    const actualChroma = chromaPlanes(actualImage);
    const expectedChroma = chromaPlanes(expectedImage);
    let squaredError = 0;
    let absoluteError = 0;
    let comparedPixels = 0;
    let excludedPixels = 0;
    for (let index = 0; index < actual.length; index += 1) {
      if (mask[index]) {
        excludedPixels += 1;
        continue;
      }
      const difference = actual[index] - expected[index];
      squaredError += difference * difference;
      absoluteError += Math.abs(difference);
      comparedPixels += 1;
    }
    const mse = comparedPixels > 0 ? squaredError / comparedPixels : 255 ** 2;
    const ssim = computeSsimComponents(actual, expected, width, height, mask);
    const multiScale = computeMultiScaleSsim(
      actual,
      expected,
      width,
      height,
      mask,
    );
    const actualCb = downsamplePlane2x(actualChroma.cb, width, height);
    const expectedCb = downsamplePlane2x(expectedChroma.cb, width, height);
    const actualCr = downsamplePlane2x(actualChroma.cr, width, height);
    const expectedCr = downsamplePlane2x(expectedChroma.cr, width, height);
    const chromaMask = downsampleMask2x(mask, width, height);
    let chromaSquaredError = 0;
    let chromaAbsoluteError = 0;
    let comparedChromaPixels = 0;
    for (let index = 0; index < actualCb.plane.length; index += 1) {
      if (chromaMask.mask[index]) continue;
      const cbDifference = actualCb.plane[index] - expectedCb.plane[index];
      const crDifference = actualCr.plane[index] - expectedCr.plane[index];
      chromaSquaredError += cbDifference ** 2 + crDifference ** 2;
      chromaAbsoluteError += Math.abs(cbDifference) + Math.abs(crDifference);
      comparedChromaPixels += 1;
    }
    const chromaMse =
      comparedChromaPixels > 0
        ? chromaSquaredError / (comparedChromaPixels * 2)
        : 255 ** 2;
    const cbSsim = computeSsimComponents(
      actualCb.plane,
      expectedCb.plane,
      actualCb.width,
      actualCb.height,
      chromaMask.mask,
    ).ssim;
    const crSsim = computeSsimComponents(
      actualCr.plane,
      expectedCr.plane,
      actualCr.width,
      actualCr.height,
      chromaMask.mask,
    ).ssim;
    const expectedBlockiness = rawBlockiness(expected, width, height, mask);
    const actualBlockiness = rawBlockiness(actual, width, height, mask);
    return {
      ssim: round(ssim.ssim),
      multiScaleSsim: round(multiScale.value),
      multiScaleLevels: multiScale.levels.map((level) => ({
        level: level.level,
        width: level.width,
        height: level.height,
        luminance: round(level.luminance),
        contrastStructure: round(level.contrastStructure),
        ssim: round(level.ssim),
      })),
      psnrDb: round(
        mse <= Number.EPSILON ? 100 : 10 * Math.log10(255 ** 2 / mse),
        4,
      ),
      chromaPsnrDb: round(
        chromaMse <= Number.EPSILON
          ? 100
          : 10 * Math.log10(255 ** 2 / chromaMse),
        4,
      ),
      chromaSsim: round((cbSsim + crSsim) / 2),
      meanAbsoluteLumaError: round(
        comparedPixels > 0 ? absoluteError / comparedPixels : 255,
        4,
      ),
      meanAbsoluteChromaError: round(
        comparedChromaPixels > 0
          ? chromaAbsoluteError / (comparedChromaPixels * 2)
          : 255,
        4,
      ),
      edgeRetention: round(edgeRetention(actual, expected, width, height, mask)),
      blockiness: round(Math.max(0, actualBlockiness - expectedBlockiness)),
      actualBlockiness: round(actualBlockiness),
      expectedBlockiness: round(expectedBlockiness),
      comparedPixels,
      comparedChromaPixels,
      excludedPixels,
      excludedPixelRatio: round(excludedPixels / Math.max(1, width * height)),
    };
  };

  const motionWeightedAlignment = ({
    actualImage,
    currentImage,
    previousImage,
    nextImage,
    providedMask = null,
  }) => {
    const width = actualImage.width;
    const height = actualImage.height;
    for (const image of [currentImage, previousImage, nextImage]) {
      if (image.width !== width || image.height !== height) {
        throw new RangeError("alignment frames must have identical dimensions");
      }
    }
    const mask = resolveMask(width, height, providedMask);
    const actual = lumaPlane(actualImage);
    const current = lumaPlane(currentImage);
    const previous = lumaPlane(previousImage);
    const next = lumaPlane(nextImage);
    let weightSum = 0;
    let currentError = 0;
    let previousError = 0;
    let nextError = 0;
    for (let index = 0; index < actual.length; index += 1) {
      if (mask[index]) continue;
      const weight = Math.max(
        Math.abs(current[index] - previous[index]),
        Math.abs(current[index] - next[index]),
      );
      if (weight <= 1e-6) continue;
      weightSum += weight;
      currentError += weight * Math.abs(actual[index] - current[index]);
      previousError += weight * Math.abs(actual[index] - previous[index]);
      nextError += weight * Math.abs(actual[index] - next[index]);
    }
    if (weightSum <= 1e-6) {
      return {
        valid: false,
        weightSum: 0,
        currentError: null,
        previousError: null,
        nextError: null,
        margin: null,
        currentWins: false,
      };
    }
    currentError /= weightSum;
    previousError /= weightSum;
    nextError /= weightSum;
    const competingError = Math.min(previousError, nextError);
    return {
      valid: true,
      weightSum: round(weightSum, 2),
      currentError: round(currentError),
      previousError: round(previousError),
      nextError: round(nextError),
      margin: round(
        (competingError - currentError) / Math.max(currentError, 1e-6),
      ),
      currentWins: currentError < competingError,
    };
  };

  return {
    lumaPlane,
    chromaPlanes,
    downsamplePlane2x,
    downsampleMask2x,
    computeSsimComponents,
    computeMultiScaleSsim,
    compareImages,
    motionWeightedAlignment,
  };
}

export { DEFAULT_MS_SSIM_WEIGHTS };
