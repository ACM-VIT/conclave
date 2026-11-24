import { isIP } from "node:net";
import { canonicalHost } from "./bindAddress.js";

/** How the control API authenticates callers, where it listens, and who may call it from a browser. */
export interface ServiceSecurity {
    token: string;
    listenHost: string;
    listenPort: number;
    corsOrigins: string[];
}

export class ServiceSecurityError extends Error {
    constructor(readonly problems: string[]) {
        super(`Shared browser service refused to start:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
        this.name = "ServiceSecurityError";
    }
}

const MIN_TOKEN_LENGTH = 32;
const MIN_DISTINCT_TOKEN_CHARACTERS = 8;
// The SFU sends the token in an HTTP header, so it must be visible ASCII.
const HEADER_SAFE_TOKEN = /^[\x21-\x7e]+$/;
const DEFAULT_LISTEN_HOST = "127.0.0.1";
export const DEFAULT_LISTEN_PORT = 3040;

const isLoopbackOrPrivateIpv4 = (host: string): boolean => {
    const [a, b] = host.split(".").map(Number);
    return (
        a === 127 ||
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127)
    );
};

const isLoopbackOrPrivateIpv6 = (canonical: string): boolean => canonical === "::1" || /^f[cd][0-9a-f]{2}:/.test(canonical);

export const isLoopbackOrPrivateHost = (host: string): boolean => {
    const canonical = canonicalHost(host);
    if (canonical === "localhost") return true;
    const version = isIP(canonical);
    if (version === 4) return isLoopbackOrPrivateIpv4(canonical);
    if (version === 6) return isLoopbackOrPrivateIpv6(canonical);
    return false;
};

// Fetch strips only these from the ends of a header value; String#trim would
// also drop Unicode spaces the SFU still sends.
const trimHttpWhitespace = (value: string): string => value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");

const readToken = (raw: string | undefined, problems: string[]): string => {
    const token = trimHttpWhitespace(raw ?? "");
    if (!token) {
        problems.push("BROWSER_SERVICE_TOKEN is required. Generate one with `openssl rand -hex 32` and set the same value on the SFU.");
    } else if (token.length < MIN_TOKEN_LENGTH || new Set(token).size < MIN_DISTINCT_TOKEN_CHARACTERS) {
        problems.push(`BROWSER_SERVICE_TOKEN must be a random value of at least ${MIN_TOKEN_LENGTH} characters.`);
    } else if (!HEADER_SAFE_TOKEN.test(token)) {
        problems.push("BROWSER_SERVICE_TOKEN may contain only visible ASCII characters, with no spaces, because the SFU sends it as an HTTP header.");
    }
    return token;
};

const readListenHost = (raw: string | undefined, problems: string[]): string => {
    if (raw === undefined || raw === "") return DEFAULT_LISTEN_HOST;
    if (raw !== raw.trim()) {
        problems.push(`BROWSER_SERVICE_HOST=${JSON.stringify(raw)} must be an address with no spaces.`);
        return DEFAULT_LISTEN_HOST;
    }
    const host = raw;
    if (!isLoopbackOrPrivateHost(host)) {
        problems.push(
            `BROWSER_SERVICE_HOST=${host} is not a loopback or private address. Bind the control API to 127.0.0.1 or the private address the SFU reaches it on.`,
        );
    }
    return host;
};

// Not trimmed: the deploy scripts build their health URL from the value as written.
const readListenPort = (raw: string | undefined, problems: string[]): number => {
    if (raw === undefined || raw === "") return DEFAULT_LISTEN_PORT;
    const port = Number(raw);
    if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
        problems.push(`BROWSER_SERVICE_PORT=${JSON.stringify(raw)} must be a port number from 1 to 65535, with no spaces.`);
        return DEFAULT_LISTEN_PORT;
    }
    return port;
};

const readCorsOrigins = (raw: string | undefined, problems: string[]): string[] => {
    const entries = (raw ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    const origins = new Set<string>();
    for (const entry of entries) {
        let url: URL | undefined;
        try {
            url = new URL(entry);
        } catch {
            url = undefined;
        }
        if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
            problems.push(`BROWSER_SERVICE_CORS_ORIGINS entry ${JSON.stringify(entry)} is not an http(s) origin.`);
            continue;
        }
        origins.add(url.origin);
    }
    return [...origins];
};

export const resolveServiceSecurity = (env: NodeJS.ProcessEnv): ServiceSecurity => {
    const problems: string[] = [];
    const security = {
        token: readToken(env.BROWSER_SERVICE_TOKEN, problems),
        listenHost: readListenHost(env.BROWSER_SERVICE_HOST, problems),
        listenPort: readListenPort(env.BROWSER_SERVICE_PORT, problems),
        corsOrigins: readCorsOrigins(env.BROWSER_SERVICE_CORS_ORIGINS, problems),
    };
    if (problems.length > 0) throw new ServiceSecurityError(problems);
    return security;
};
