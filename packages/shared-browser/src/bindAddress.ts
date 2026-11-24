import { isIP, SocketAddress } from "node:net";

export type BindAddress = { host: string; port: number };

const IPV4_ANY = "0.0.0.0";
const IPV6_ANY = "::";
const MAPPED_IPV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/;

export const canonicalHost = (raw: string): string => {
    const trimmed = raw.trim();
    if (trimmed === "") return IPV4_ANY;
    const unbracketed = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
    const zoneAt = unbracketed.indexOf("%");
    const address = zoneAt < 0 ? unbracketed : unbracketed.slice(0, zoneAt);
    const zone = zoneAt < 0 ? "" : unbracketed.slice(zoneAt).toLowerCase();
    const family = isIP(address);
    if (family === 4) return new SocketAddress({ address, family: "ipv4" }).address;
    if (family === 6) {
        const canonical = new SocketAddress({ address, family: "ipv6" }).address;
        const mapped = zone ? null : MAPPED_IPV4.exec(canonical);
        return mapped ? mapped[1] : `${canonical}${zone}`;
    }
    return unbracketed.toLowerCase();
};

export const isIpv4Host = (raw: string): boolean => isIP(canonicalHost(raw)) === 4;

export const bindingCovers = (bound: BindAddress, listener: BindAddress): boolean => {
    if (bound.port !== listener.port) return false;
    const holder = canonicalHost(bound.host);
    if (holder === IPV6_ANY) return true;
    if (holder === IPV4_ANY) return isIpv4Host(listener.host);
    return holder === canonicalHost(listener.host);
};

export const parseBindings = (raw: string, defaultPort: number): BindAddress[] =>
    raw.split(",").flatMap((entry) => {
        if (entry.trim() === "") return [];
        const parts = entry.split("|");
        if (parts.length !== 2) return [];
        const [host, port] = parts;
        if (port.trim() === "") return [{ host, port: defaultPort }];
        return /^\d+$/.test(port.trim()) ? [{ host, port: Number(port.trim()) }] : [];
    });
