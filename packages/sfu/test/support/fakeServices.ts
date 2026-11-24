export type GateKind = "commit" | "freebusy" | "google-create" | "email";

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
      const busy = this.busy.map((entry) => ({
        start: new Date(entry.startAt).toISOString(),
        end: new Date(entry.endAt).toISOString(),
      }));
      return json(200, { calendars: { primary: { busy } } });
    }
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST" && url.pathname.endsWith("/events")) {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        start: { dateTime: string };
        end: { dateTime: string };
        description: string;
      };
      await this.gates.admit("google-create", payload.description.slice(-40));
      const event = {
        id: `event-${this.next++}`,
        startAt: Date.parse(payload.start.dateTime),
        endAt: Date.parse(payload.end.dateTime),
        description: payload.description,
      };
      this.events.set(event.id, event);
      this.created.push(event);
      return json(200, { id: event.id });
    }
    if (method === "DELETE") {
      const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      this.events.delete(id);
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

