import dns from "node:dns";
import { isIP } from "node:net";
import { canonicalHost } from "./bindAddress.js";

export type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;

export type ResolvedListenHost = { ok: true; address: string } | { ok: false; problem: string };

const systemLookup: Lookup = (host) => dns.promises.lookup(host, { all: true });

const literalAddress = (host: string): string | null => {
    const unbracketed = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    const zoneAt = unbracketed.indexOf("%");
    return isIP(zoneAt < 0 ? unbracketed : unbracketed.slice(0, zoneAt)) ? unbracketed : null;
};

export const resolveListenHost = async (
    host: string,
    isAllowed: (address: string) => boolean,
    lookup: Lookup = systemLookup,
): Promise<ResolvedListenHost> => {
    const literal = literalAddress(host);
    if (literal !== null) return { ok: true, address: literal };
    let resolved: Array<{ address: string }>;
    try {
        resolved = await lookup(host);
    } catch (error) {
        const reason = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
        return { ok: false, problem: `BROWSER_SERVICE_HOST=${host} does not resolve on this host (${reason}). Set it to an address, or to a name this host resolves.` };
    }
    if (resolved.length === 0) return { ok: false, problem: `BROWSER_SERVICE_HOST=${host} resolves to no address. Set it to an address.` };
    const outside = resolved.map(({ address }) => address).filter((address) => !isAllowed(address));
    if (outside.length > 0) {
        return {
            ok: false,
            problem: `BROWSER_SERVICE_HOST=${host} resolves to ${outside.join(", ")}, which is not a loopback or private address. Bind the control API to 127.0.0.1 or the private address the SFU reaches it on.`,
        };
    }
    return { ok: true, address: canonicalHost(resolved[0].address) };
};
