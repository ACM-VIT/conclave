import { isIP } from "node:net";

/** How the control API authenticates callers, where it listens, and who may call it from a browser. */
export interface ServiceSecurity {
    token: string;
    listenHost: string;
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

const isLoopbackOrPrivateIpv6 = (host: string): boolean => {
    const normalized = new URL(`http://[${host}]`).hostname.slice(1, -1);
    // Unique-local fc00::/7: the first hextet is fcXX or fdXX in full.
    return normalized === "::1" || /^f[cd][0-9a-f]{2}:/.test(normalized);
};

const isLoopbackOrPrivateHost = (host: string): boolean => {
    if (host === "localhost") return true;
    const version = isIP(host);
    if (version === 4) return isLoopbackOrPrivateIpv4(host);
    if (version === 6) return isLoopbackOrPrivateIpv6(host);
    return false;
};

const readToken = (raw: string | undefined, problems: string[]): string => {
    const token = raw?.trim() ?? "";
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
    const host = raw?.trim() || DEFAULT_LISTEN_HOST;
    if (!isLoopbackOrPrivateHost(host)) {
        problems.push(
            `BROWSER_SERVICE_HOST=${host} is not a loopback or private address. Bind the control API to 127.0.0.1 or the private address the SFU reaches it on.`,
        );
    }
    return host;
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
        corsOrigins: readCorsOrigins(env.BROWSER_SERVICE_CORS_ORIGINS, problems),
    };
    if (problems.length > 0) throw new ServiceSecurityError(problems);
    return security;
};
