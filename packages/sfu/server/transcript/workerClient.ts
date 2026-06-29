import type { TranscriptSpeaker } from "../../types.js";

const WORKER_CONNECT_TIMEOUT_MS = 8000;
const WORKER_HANDOFF_TIMEOUT_MS = 1000;

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

export class TranscriptWorkerRelayClient {
  private socket: WebSocket | null = null;
  private readonly handoffResolvers = new Map<string, (ok: boolean) => void>();

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
        if (error) reject(error);
        else resolve();
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
        this.options.onError?.("Transcript worker relay socket failed.");
      };
      socket.onclose = () => {
        const isCurrentSocket = this.socket === socket;
        if (isCurrentSocket) {
          this.socket = null;
        }
        if (!settled) {
          finish(new Error("Transcript worker relay connection closed."));
          return;
        }
        if (isCurrentSocket) {
          this.options.onClose?.("Transcript worker relay disconnected.");
        }
      };
    });
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
    const socket = this.socket;
    this.socket = null;
    for (const resolve of this.handoffResolvers.values()) {
      resolve(false);
    }
    this.handoffResolvers.clear();
    try {
      socket?.close();
    } catch {}
  }

  private send(payload: unknown): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(payload));
    return true;
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
