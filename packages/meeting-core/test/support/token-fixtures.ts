const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

const encoded = (value: unknown): string => base64url(new TextEncoder().encode(JSON.stringify(value)));

export const fakeSignedToken = (claims: Record<string, unknown> = { sub: "fixture" }): string =>
  [encoded({ alg: "HS256", typ: "JWT" }), encoded(claims), base64url(crypto.getRandomValues(new Uint8Array(32)))].join(".");

export const fakeSecretKey = (prefix: "phc" | "sk", body: string): string => [prefix, body].join(prefix === "phc" ? "_" : "-");
