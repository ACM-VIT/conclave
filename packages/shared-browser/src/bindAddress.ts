import dns from "node:dns";
import { isIP, SocketAddress } from "node:net";

declare const resolvedHost: unique symbol;

export type ResolvedHost = string & { readonly [resolvedHost]: true };

export type RawBinding = { host: string; port: number };

export type ResolvedBinding = { host: ResolvedHost; port: number };

export type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;

export type HostResolution =
    | { ok: true; host: ResolvedHost; answers: ResolvedHost[] }
    | { ok: false; failure: "unresolved"; code: string }
    | { ok: false; failure: "no address" };

const IPV4_ANY = "0.0.0.0" as ResolvedHost;
const IPV6_ANY = "::" as ResolvedHost;
const MAPPED_IPV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/;

export const systemLookup: Lookup = (host) => dns.promises.lookup(host, { all: true });

export const canonicalLiteral = (raw: string): ResolvedHost | null => {
    const trimmed = raw.trim();
    const unbracketed = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
    const zoneAt = unbracketed.indexOf("%");
    const address = zoneAt < 0 ? unbracketed : unbracketed.slice(0, zoneAt);
    const zone = zoneAt < 0 ? "" : unbracketed.slice(zoneAt).toLowerCase();
    const family = isIP(address);
    if (family === 4) return new SocketAddress({ address, family: "ipv4" }).address as ResolvedHost;
    if (family !== 6) return null;
    const canonical = new SocketAddress({ address, family: "ipv6" }).address;
    const mapped = zone ? null : MAPPED_IPV4.exec(canonical);
    return (mapped ? mapped[1] : `${canonical}${zone}`) as ResolvedHost;
};

export const resolveHost = async (raw: string, lookup: Lookup = systemLookup): Promise<HostResolution> => {
    if (raw.trim() === "") return { ok: true, host: IPV4_ANY, answers: [IPV4_ANY] };
    const literal = canonicalLiteral(raw);
    if (literal !== null) return { ok: true, host: literal, answers: [literal] };
    let answers: Array<{ address: string }>;
    try {
        answers = await lookup(raw.trim());
    } catch (error) {
        return { ok: false, failure: "unresolved", code: (error as NodeJS.ErrnoException).code ?? (error as Error).message };
    }
    const resolved = answers.map(({ address }) => canonicalLiteral(address)).filter((host): host is ResolvedHost => host !== null);
    if (resolved.length === 0) return { ok: false, failure: "no address" };
    return { ok: true, host: resolved[0], answers: resolved };
};

export const urlHost = (host: ResolvedHost): string => (isIP(host.split("%")[0]) === 6 ? `[${host.replace("%", "%25")}]` : host);

export const bindingCovers = (bound: ResolvedBinding, listener: ResolvedBinding): boolean => {
    if (bound.port !== listener.port) return false;
    if (bound.host === IPV6_ANY) return true;
    if (bound.host === IPV4_ANY) return isIP(listener.host) === 4;
    return bound.host === listener.host;
};

export const parseBindings = (raw: string, defaultPort: number): RawBinding[] =>
    raw.split(",").flatMap((entry) => {
        if (entry.trim() === "") return [];
        const parts = entry.split("|");
        if (parts.length !== 2) return [];
        const [host, port] = parts;
        if (port.trim() === "") return [{ host, port: defaultPort }];
        return /^\d+$/.test(port.trim()) ? [{ host, port: Number(port.trim()) }] : [];
    });

export const resolveBindings = async (bindings: RawBinding[], lookup: Lookup = systemLookup): Promise<ResolvedBinding[]> => {
    const resolved = await Promise.all(
        bindings.map(async ({ host, port }) => {
            const resolution = await resolveHost(host, lookup);
            return resolution.ok ? [{ host: resolution.host, port }] : [];
        }),
    );
    return resolved.flat();
};

export type ListenHostResolution = { ok: true; address: ResolvedHost } | { ok: false; problem: string };

export const resolveListenHost = async (
    host: string,
    isAllowed: (address: ResolvedHost) => boolean,
    lookup: Lookup = systemLookup,
): Promise<ListenHostResolution> => {
    const resolution = await resolveHost(host, lookup);
    if (!resolution.ok) {
        return {
            ok: false,
            problem:
                resolution.failure === "unresolved"
                    ? `BROWSER_SERVICE_HOST=${host} does not resolve on this host (${resolution.code}). Set it to an address, or to a name this host resolves.`
                    : `BROWSER_SERVICE_HOST=${host} resolves to no address. Set it to an address.`,
        };
    }
    const outside = resolution.answers.filter((address) => !isAllowed(address));
    if (outside.length > 0) {
        return {
            ok: false,
            problem: `BROWSER_SERVICE_HOST=${host} resolves to ${outside.join(", ")}, which is not a loopback or private address. Bind the control API to 127.0.0.1 or the private address the SFU reaches it on.`,
        };
    }
    return { ok: true, address: resolution.host };
};
