export class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async open() {
    this.socket = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
      this.socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id && this.pending.has(message.id)) {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) {
            pending.reject(new Error(message.error.message));
          } else {
            pending.resolve(message.result);
          }
          return;
        }
        if (!message.method) return;
        for (const listener of this.listeners.get(message.method) ?? []) {
          listener(message.params ?? {});
        }
      });
    });
  }

  send(method, params = {}, timeoutMs = 10_000, sessionId = null) {
    if (!this.socket) throw new Error("CDP client is not open");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }

  sendToSession(sessionId, method, params = {}, timeoutMs = 10_000) {
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      throw new TypeError("CDP sessionId is required");
    }
    return this.send(method, params, timeoutMs, sessionId.trim());
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  close() {
    this.socket?.close();
    this.socket = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP client closed"));
    }
    this.pending.clear();
  }
}

export async function evaluate(cdp, expression, timeoutMs = 10_000) {
  const result = await cdp.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutMs,
    },
    timeoutMs + 1_000,
  );
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Runtime.evaluate failed",
    );
  }
  return result.result.value;
}

export async function waitForEvaluation(
  cdp,
  label,
  expression,
  timeoutMs = 30_000,
) {
  const startedAt = Date.now();
  let lastValue = null;
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastValue = await evaluate(cdp, expression, 5_000);
      if (lastValue?.ok === true) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for ${label}: ${JSON.stringify(lastValue)}${
      lastError ? ` (${lastError.message})` : ""
    }`,
  );
}
