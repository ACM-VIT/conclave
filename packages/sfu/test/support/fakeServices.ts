export type GateKind = "commit" | "freebusy" | "google-create" | "google-created" | "google-delete" | "email" | "redis";

export class Gates {
  parking = new Set<GateKind>();
  parked: Array<{ kind: GateKind; label: string; release: () => void }> = [];

  admit(kind: GateKind, label: string): Promise<void> {
    if (!this.parking.has(kind)) return Promise.resolve();
    return new Promise((resolve) => this.parked.push({ kind, label, release: resolve }));
  }

  releaseAt(index: number): string {
    const [entry] = this.parked.splice(index, 1);
    entry.release();
    return `${entry.kind} ${entry.label}`;
  }

  drop(kind: GateKind): number {
    const dropped = this.parked.filter((entry) => entry.kind === kind);
    this.parked = this.parked.filter((entry) => entry.kind !== kind);
    this.parking.delete(kind);
    return dropped.length;
  }

  drain(): void {
    this.parking.clear();
    for (const entry of this.parked.splice(0)) entry.release();
  }
}

export type FakeEvent = { id: string; startAt: number; endAt: number; description: string };

export class FakeGoogle {
  events = new Map<string, FakeEvent>();
  created: FakeEvent[] = [];
  busy: Array<{ startAt: number; endAt: number }> = [];
  private readonly usedIds = new Set<string>();
  createAttempts = 0;
  failCreatesWith: number | null = null;
  private next = 1;

  constructor(private readonly gates: Gates) {}

  async handle(url: URL, init: RequestInit | undefined): Promise<Response> {
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.hostname === "oauth2.googleapis.com") {
      return json(200, { access_token: `access-${this.next++}`, expires_in: 3600 });
    }
    if (url.pathname.endsWith("/freeBusy")) {
      await this.gates.admit("freebusy", url.pathname);
      const window = JSON.parse(String(init?.body ?? "{}")) as { timeMin?: string; timeMax?: string };
      const from = window.timeMin ? Date.parse(window.timeMin) : -Infinity;
      const to = window.timeMax ? Date.parse(window.timeMax) : Infinity;
      const busy = this.busy.filter((entry) => entry.startAt < to && entry.endAt > from).map((entry) => ({
        start: new Date(entry.startAt).toISOString(),
        end: new Date(entry.endAt).toISOString(),
      }));
      return json(200, { calendars: { primary: { busy } } });
    }
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST" && url.pathname.endsWith("/events")) {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        id?: string;
        start: { dateTime: string };
        end: { dateTime: string };
        description: string;
      };
      await this.gates.admit("google-create", payload.description.slice(-40));
      this.createAttempts += 1;
      if (this.failCreatesWith) return json(this.failCreatesWith, { error: { code: this.failCreatesWith, status: "UNAVAILABLE" } });
      const id = payload.id ?? `event-${this.next++}`;
      if (this.usedIds.has(id)) return json(409, { error: { code: 409, status: "ALREADY_EXISTS", message: "The requested identifier already exists." } });
      this.usedIds.add(id);
      const event = {
        id,
        startAt: Date.parse(payload.start.dateTime),
        endAt: Date.parse(payload.end.dateTime),
        description: payload.description,
      };
      this.events.set(event.id, event);
      this.created.push(event);
      await this.gates.admit("google-created", event.id);
      return json(200, { id: event.id });
    }
    if (method === "DELETE") {
      const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      await this.gates.admit("google-delete", id);
      if (!this.events.delete(id)) return json(this.usedIds.has(id) ? 410 : 404, { error: "not found" });
      return new Response(null, { status: 204 });
    }
    return json(404, { error: "not found" });
  }
}

export type SentEmail = { type: string; meetingId: string; to: string };

export class FakeEmail {
  sent: SentEmail[] = [];

  constructor(private readonly gates: Gates) {}

  async handle(init: RequestInit | undefined): Promise<Response> {
    const payload = JSON.parse(String(init?.body ?? "{}")) as {
      messages: Array<{ to: { email: string }; headers?: Record<string, string> }>;
    };
    const first = payload.messages[0];
    await this.gates.admit("email", first?.headers?.["X-Conclave-Meeting-Id"] ?? "");
    for (const message of payload.messages) {
      this.sent.push({
        type: message.headers?.["X-Conclave-Email-Type"] ?? "",
        meetingId: message.headers?.["X-Conclave-Meeting-Id"] ?? "",
        to: message.to.email,
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
}

export const EMAIL_WORKER_URL = "http://email.model.test";

export const installFakeFetch = (google: () => FakeGoogle | null, email: () => FakeEmail | null) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const fakeGoogle = google();
    const fakeEmail = email();
    if (fakeGoogle && url.hostname.endsWith("googleapis.com")) return fakeGoogle.handle(url, init);
    if (fakeEmail && url.origin === EMAIL_WORKER_URL) return fakeEmail.handle(init);
    return original(input, init);
  });
  return () => {
    globalThis.fetch = original;
  };
};

