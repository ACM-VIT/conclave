import type { TranscriptSpeaker } from "../../types.js";

const WORKER_CONNECT_TIMEOUT_MS = 8000;
const WORKER_HANDOFF_TIMEOUT_MS = 5000;
const WORKER_HEARTBEAT_INTERVAL_MS = 20000;
const WORKER_HEARTBEAT_TIMEOUT_MS = 55000;
const WORKER_RECOVERY_DEADLINE_MS = 2 * 60 * 1000;
const WORKER_RECOVERY_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const WORKER_RECOVERY_MAX_BUFFER_AGE_MS = 2 * 60 * 1000;
const WORKER_RECOVERY_MAX_BUFFER_MESSAGES = 2000;
const WORKER_RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 10000];

type QueuedWorkerMessage = {
  serialized: string;
  bytes: number;
  createdAt: number;
};

const toWorkerWebSocketUrl = (
  workerUrl: string,
  roomId: string,
  token: string,
): string => {
  const base = workerUrl.replace(/\/+$/, "");
  const url = new URL(`${base}/rooms/${encodeURIComponent(roomId)}/ws`);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  }
  url.searchParams.set("token", token);
  return url.toString();
};

const isBufferableAudioMessage = (payload: unknown): boolean => {
  if (!payload || typeof payload !== "object" || !("type" in payload)) {
    return false;
  }
  const type = (payload as { type?: unknown }).type;
  return (
    type === "audio.chunk" || type === "audio.commit" || type === "audio.clear"
  );
};

export class TranscriptWorkerRelayClient {
  private socket: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectingPromise: Promise<void> | null = null;
  private readonly handoffResolvers = new Map<string, (ok: boolean) => void>();
  private queuedMessages: QueuedWorkerMessage[] = [];
  private queuedBytes = 0;
  private lastPongAt = 0;
  private reconnectAttempt = 0;
  private recoveryStartedAt = 0;
  private hasConnected = false;
  private intentionallyClosed = false;

  constructor(
    private readonly options: {
      workerUrl: string;
      roomId: string;
      token: string;
      onError?: (message: string) => void;
      onClose?: (message: string) => void;
    },
  ) {}

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectingPromise) return this.connectingPromise;
    this.intentionallyClosed = false;
    const connecting = this.openSocket();
    this.connectingPromise = connecting;
    try {
      await connecting;
    } finally {
      if (this.connectingPromise === connecting) this.connectingPromise = null;
    }
  }

  sendAudioChunk(audio: string, speaker: TranscriptSpeaker): boolean {
    return this.send({ type: "audio.chunk", audio, speaker });
  }

  commitAudio(speaker: TranscriptSpeaker): boolean {
    return this.send({ type: "audio.commit", speaker });
  }

  clearAudio(speaker: TranscriptSpeaker): boolean {
    return this.send({ type: "audio.clear", speaker });
  }

  async prepareHandoff(): Promise<boolean> {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    const id = `handoff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sent = this.send({ type: "relay.handoff.prepare", id });
    if (!sent) return false;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.handoffResolvers.delete(id);
        resolve(false);
      }, WORKER_HANDOFF_TIMEOUT_MS);
      this.handoffResolvers.set(id, (ok) => {
        clearTimeout(timeout);
        resolve(ok);
      });
    });
  }

  close(): void {
    this.intentionallyClosed = true;
    this.hasConnected = false;
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = null;
    this.stopHeartbeat();
    for (const resolve of this.handoffResolvers.values()) {
      resolve(false);
    }
    this.handoffResolvers.clear();
    this.queuedMessages = [];
    this.queuedBytes = 0;
    try {
      socket?.close();
    } catch {}
  }

  private async openSocket(): Promise<void> {
    const socket = new WebSocket(
      toWorkerWebSocketUrl(
        this.options.workerUrl,
        this.options.roomId,
        this.options.token,
      ),
    );
    this.socket = socket;

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data ?? "")) as {
          type?: string;
          message?: string;
          id?: string;
        };
        if (
          message.type === "relay.handoff.ready" &&
          typeof message.id === "string"
        ) {
          this.handoffResolvers.get(message.id)?.(true);
          this.handoffResolvers.delete(message.id);
        } else if (message.type === "relay.pong") {
          this.lastPongAt = Date.now();
        } else if (message.type === "error" && message.message) {
          this.options.onError?.(message.message);
        }
      } catch {}
    };

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) {
          reject(error);
          return;
        }
        this.hasConnected = true;
        this.reconnectAttempt = 0;
        this.recoveryStartedAt = 0;
        this.lastPongAt = Date.now();
        this.startHeartbeat(socket);
        this.flushQueuedMessages(socket);
        resolve();
      };
      const timeout = setTimeout(() => {
        try {
          socket.close();
        } catch {}
        finish(new Error("Transcript worker relay connection timed out."));
      }, WORKER_CONNECT_TIMEOUT_MS);
      socket.onopen = () => finish();
      socket.onerror = () => {
        const message = "Transcript worker relay connection failed.";
        if (!settled) {
          finish(new Error(message));
          return;
        }
        this.options.onError?.("Transcript worker relay socket failed; reconnecting.");
        try {
          socket.close();
        } catch {}
      };
      socket.onclose = () => {
        const isCurrentSocket = this.socket === socket;
        if (isCurrentSocket) {
          this.socket = null;
          this.stopHeartbeat();
        }
        if (!settled) {
          finish(new Error("Transcript worker relay connection closed."));
          return;
        }
        if (isCurrentSocket && !this.intentionallyClosed) {
          this.scheduleReconnect();
        }
      };
    });
  }

  private send(payload: unknown): boolean {
    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      return false;
    }
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(serialized);
        return true;
      } catch {
        try {
          socket.close();
        } catch {}
        // Queue the audio below while the replacement socket connects.
      }
    }
    if (
      this.hasConnected &&
      !this.intentionallyClosed &&
      isBufferableAudioMessage(payload)
    ) {
      this.enqueueMessage(serialized);
      this.scheduleReconnect();
      return true;
    }
    return false;
  }

  private enqueueMessage(serialized: string): void {
    const message: QueuedWorkerMessage = {
      serialized,
      bytes: Buffer.byteLength(serialized),
      createdAt: Date.now(),
    };
    this.queuedMessages.push(message);
    this.queuedBytes += message.bytes;
    this.pruneQueuedMessages();
  }

  private pruneQueuedMessages(): void {
    const cutoff = Date.now() - WORKER_RECOVERY_MAX_BUFFER_AGE_MS;
    while (
      this.queuedMessages.length > 0 &&
      (this.queuedMessages.length > WORKER_RECOVERY_MAX_BUFFER_MESSAGES ||
        this.queuedBytes > WORKER_RECOVERY_MAX_BUFFER_BYTES ||
        (this.queuedMessages[0]?.createdAt ?? cutoff) < cutoff)
    ) {
      const removed = this.queuedMessages.shift();
      if (!removed) break;
      this.queuedBytes -= removed.bytes;
    }
  }

  private flushQueuedMessages(socket: WebSocket): void {
    this.pruneQueuedMessages();
    while (
      this.socket === socket &&
      socket.readyState === WebSocket.OPEN &&
      this.queuedMessages.length > 0
    ) {
      const message = this.queuedMessages[0];
      if (!message) break;
      try {
        socket.send(message.serialized);
      } catch {
        try {
          socket.close();
        } catch {}
        return;
      }
      this.queuedMessages.shift();
      this.queuedBytes -= message.bytes;
    }
  }

  private scheduleReconnect(): void {
    if (
      this.intentionallyClosed ||
      this.reconnectTimer ||
      this.connectingPromise ||
      this.socket?.readyState === WebSocket.OPEN
    ) {
      return;
    }
    const now = Date.now();
    if (this.recoveryStartedAt === 0) this.recoveryStartedAt = now;
    if (now - this.recoveryStartedAt >= WORKER_RECOVERY_DEADLINE_MS) {
      this.hasConnected = false;
      this.queuedMessages = [];
      this.queuedBytes = 0;
      this.options.onClose?.(
        "Transcript worker relay could not reconnect automatically.",
      );
      return;
    }

    const delay =
      WORKER_RECONNECT_DELAYS_MS[
        Math.min(this.reconnectAttempt, WORKER_RECONNECT_DELAYS_MS.length - 1)
      ] ?? 10000;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    if (this.intentionallyClosed || this.connectingPromise) return;
    const connecting = this.openSocket();
    this.connectingPromise = connecting;
    try {
      await connecting;
    } catch (error) {
      this.options.onError?.(
        error instanceof Error
          ? `${error.message} Retrying automatically.`
          : "Transcript worker relay reconnect failed. Retrying automatically.",
      );
      this.scheduleReconnect();
    } finally {
      if (this.connectingPromise === connecting) this.connectingPromise = null;
      if (!this.intentionallyClosed && !this.socket) this.scheduleReconnect();
    }
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
        this.stopHeartbeat();
        return;
      }
      if (Date.now() - this.lastPongAt > WORKER_HEARTBEAT_TIMEOUT_MS) {
        this.options.onError?.(
          "Transcript worker relay heartbeat timed out; reconnecting.",
        );
        try {
          socket.close();
        } catch {}
        return;
      }
      this.send({
        type: "relay.ping",
        id: `ping-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
    }, WORKER_HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

export type TranscriptWorkerRelayConnection = Pick<
  TranscriptWorkerRelayClient,
  | "connect"
  | "sendAudioChunk"
  | "commitAudio"
  | "clearAudio"
  | "prepareHandoff"
  | "close"
>;
