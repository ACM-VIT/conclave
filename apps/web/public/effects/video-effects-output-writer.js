const closeResource = (resource) => {
  try {
    resource?.close?.();
  } catch {}
};

const postWorkerError = (sequence, err) => {
  self.postMessage({
    type: "ERROR",
    sequence,
    error: {
      name: err?.name || "Error",
      message: err?.message || String(err),
      stack: err?.stack || null,
    },
  });
};

const postWorkerDropped = (sequence, reason) => {
  self.postMessage({
    type: "DROPPED",
    sequence,
    reason,
  });
};

const closeFrameMessagePayload = (message) => {
  closeResource(message?.bitmap);
  closeResource(message?.frame);
};

const dropFrameMessage = (message, reason) => {
  if (!message) return;
  closeFrameMessagePayload(message);
  postWorkerDropped(message.sequence, reason);
};

const cleanupRendererResources = () => {
  closeFrameMessagePayload(self.__conclaveQueuedFrameMessage);
  self.__conclaveQueuedFrameMessage = null;
  for (const frame of self.__conclaveActiveFrames || []) {
    closeResource(frame);
  }
  for (const bitmap of self.__conclaveActiveBitmaps || []) {
    closeResource(bitmap);
  }
};

const resetRendererState = () => {
  cleanupRendererResources();
  self.__conclaveRendererCanvas = null;
  self.__conclaveRendererCtx = null;
  self.__conclaveRendererMode = "bitmap-video-frame";
  self.__conclaveFirstFrameSent = false;
  self.__conclaveActiveFrames = new Set();
  self.__conclaveActiveBitmaps = new Set();
  self.__conclaveFrameWriteChain = Promise.resolve();
  self.__conclaveFrameWriteActive = false;
  self.__conclaveQueuedFrameMessage = null;
  self.__conclaveClosing = false;
};

const writeFrameMessage = async (message) => {
  const writer = self.__conclaveWriter;
  const bitmap = message.bitmap;
  const inputFrame = message.frame;
  const sequence = message.sequence;
  const rendererCanvas = self.__conclaveRendererCanvas;
  const rendererCtx = self.__conclaveRendererCtx;
  const activeFrames = self.__conclaveActiveFrames;
  const activeBitmaps = self.__conclaveActiveBitmaps;

  if (self.__conclaveClosing) {
    closeFrameMessagePayload(message);
    postWorkerDropped(sequence, "closing");
    return;
  }
  if (!writer) {
    closeFrameMessagePayload(message);
    throw new Error("Output writer has not been initialized.");
  }
  if (!bitmap && !inputFrame) {
    throw new Error("Frame payload is missing.");
  }
  if (typeof VideoFrame === "undefined") {
    closeFrameMessagePayload(message);
    throw new Error("VideoFrame is unavailable in output worker.");
  }

  const startedAt = performance.now();
  const frameInit = {
    duration: message.duration,
    timestamp: message.timestamp,
  };
  const outputWidth = Math.max(
    1,
    message.width ||
      inputFrame?.displayWidth ||
      inputFrame?.codedWidth ||
      bitmap?.width ||
      1,
  );
  const outputHeight = Math.max(
    1,
    message.height ||
      inputFrame?.displayHeight ||
      inputFrame?.codedHeight ||
      bitmap?.height ||
      1,
  );
  let frame = null;
  let renderer = self.__conclaveRendererMode;
  const inputMode = inputFrame ? "video-frame" : "bitmap";
  if (bitmap) {
    activeBitmaps?.add(bitmap);
  }
  if (inputFrame) {
    activeFrames?.add(inputFrame);
  }

  try {
    if (inputFrame) {
      frame = inputFrame;
      renderer = "direct-video-frame";
    } else if (
      self.__conclaveRendererMode === "offscreen-canvas" &&
      rendererCanvas &&
      rendererCtx
    ) {
      if (
        rendererCanvas.width !== outputWidth ||
        rendererCanvas.height !== outputHeight
      ) {
        rendererCanvas.width = outputWidth;
        rendererCanvas.height = outputHeight;
        rendererCtx.imageSmoothingEnabled = true;
        rendererCtx.imageSmoothingQuality = "high";
      }
      rendererCtx.clearRect(0, 0, outputWidth, outputHeight);
      rendererCtx.drawImage(bitmap, 0, 0, outputWidth, outputHeight);
      try {
        frame = new VideoFrame(rendererCanvas, frameInit);
        renderer = "offscreen-canvas";
      } catch {
        self.__conclaveRendererMode = "bitmap-video-frame";
        frame = new VideoFrame(bitmap, frameInit);
        renderer = "bitmap-video-frame";
      }
    } else {
      frame = new VideoFrame(bitmap, frameInit);
      renderer = "bitmap-video-frame";
    }

    activeFrames?.add(frame);
    closeResource(bitmap);
    activeBitmaps?.delete(bitmap);

    const readyStartedAt = performance.now();
    await writer.ready;
    const readyEndedAt = performance.now();
    await writer.write(frame);
    const writeMs = performance.now() - startedAt;
    const backpressureMs = readyEndedAt - readyStartedAt;
    const metadata = {
      sequence,
      width: outputWidth,
      height: outputHeight,
      timestamp: typeof message.timestamp === "number" ? message.timestamp : null,
      duration: typeof message.duration === "number" ? message.duration : null,
      renderer,
      inputMode,
      writeMs,
      backpressureMs,
    };

    if (!self.__conclaveFirstFrameSent) {
      self.__conclaveFirstFrameSent = true;
      self.postMessage({
        type: "FIRST_FRAME",
        sequence,
        renderer,
        inputMode,
      });
    }
    self.postMessage({
      type: "FRAME_METADATA",
      ...metadata,
    });
    self.postMessage({
      type: "WRITTEN",
      sequence,
      writeMs,
      backpressureMs,
      renderer,
      inputMode,
    });
  } finally {
    if (frame) {
      activeFrames?.delete(frame);
    }
    if (inputFrame) {
      activeFrames?.delete(inputFrame);
    }
    activeBitmaps?.delete(bitmap);
    closeResource(frame);
    closeResource(bitmap);
    if (inputFrame && inputFrame !== frame) {
      closeResource(inputFrame);
    }
  }
};

const drainFrameQueue = () => {
  if (self.__conclaveFrameWriteActive) return;
  const message = self.__conclaveQueuedFrameMessage;
  if (!message) return;

  self.__conclaveQueuedFrameMessage = null;
  self.__conclaveFrameWriteActive = true;
  self.__conclaveFrameWriteChain = writeFrameMessage(message)
    .catch((err) => {
      postWorkerError(message.sequence, err);
    })
    .finally(() => {
      self.__conclaveFrameWriteActive = false;
      if (self.__conclaveQueuedFrameMessage && !self.__conclaveClosing) {
        drainFrameQueue();
      } else if (self.__conclaveQueuedFrameMessage) {
        dropFrameMessage(self.__conclaveQueuedFrameMessage, "closing");
        self.__conclaveQueuedFrameMessage = null;
      }
    });
};

const enqueueFrameMessage = (message) => {
  if (self.__conclaveClosing) {
    dropFrameMessage(message, "closing");
    return;
  }

  if (self.__conclaveQueuedFrameMessage) {
    dropFrameMessage(self.__conclaveQueuedFrameMessage, "superseded");
  }
  self.__conclaveQueuedFrameMessage = message;
  drainFrameQueue();
};

self.onmessage = async (event) => {
  const message = event.data || {};
  try {
    switch (message.type) {
      case "INIT": {
        if (!message.writable || typeof message.writable.getWriter !== "function") {
          throw new Error("Writable stream is unavailable in output worker.");
        }
        resetRendererState();
        self.__conclaveWriter = message.writable.getWriter();
        if (
          message.canvas &&
          typeof OffscreenCanvas !== "undefined" &&
          typeof message.canvas.getContext === "function"
        ) {
          const ctx = message.canvas.getContext("2d", {
            alpha: false,
            desynchronized: true,
          });
          if (ctx) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            self.__conclaveRendererCanvas = message.canvas;
            self.__conclaveRendererCtx = ctx;
            self.__conclaveRendererMode = "offscreen-canvas";
          }
        }
        self.postMessage({
          type: "READY",
          hasVideoFrame: typeof VideoFrame !== "undefined",
          hasWritableStream: typeof WritableStream !== "undefined",
          hasOffscreenCanvas: Boolean(self.__conclaveRendererCtx),
          renderer: self.__conclaveRendererMode,
        });
        break;
      }
      case "FRAME":
        enqueueFrameMessage(message);
        break;
      case "CLOSE": {
        self.__conclaveClosing = true;
        dropFrameMessage(self.__conclaveQueuedFrameMessage, "closing");
        self.__conclaveQueuedFrameMessage = null;
        await (self.__conclaveFrameWriteChain || Promise.resolve()).catch(() => {});
        cleanupRendererResources();
        const writer = self.__conclaveWriter;
        self.__conclaveWriter = null;
        resetRendererState();
        if (writer) {
          await writer.close().catch(() => {});
          try {
            writer.releaseLock();
          } catch {}
        }
        self.postMessage({ type: "CLOSED" });
        break;
      }
      default:
        throw new Error(`Unknown output worker message: ${message.type}`);
    }
  } catch (err) {
    if (message.type === "FRAME") {
      closeFrameMessagePayload(message);
    }
    postWorkerError(message.sequence, err);
  }
};
