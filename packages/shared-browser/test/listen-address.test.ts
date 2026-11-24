import assert from "node:assert/strict";
import { isIP } from "node:net";
import test from "node:test";
import { resolveListenHost, type Lookup } from "../src/listenAddress.js";
import { isLoopbackOrPrivateHost } from "../src/serviceSecurity.js";

const answers = (addresses: string[]): Lookup => async () => addresses.map((address) => ({ address, family: isIP(address) }));
const unresolvable: Lookup = async (host) => {
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
};
const neverCalled: Lookup = async () => {
    throw new Error("an address literal must not be looked up");
};

test("a host name is resolved once, to the address the service binds and compares", async () => {
    const outcomes: Record<string, unknown> = {};
    for (const [label, host, lookup] of [
        ["localhost to IPv4 only", "localhost", answers(["127.0.0.1"])],
        ["localhost to IPv6 only", "localhost", answers(["::1"])],
        ["localhost to both, IPv6 first", "localhost", answers(["::1", "127.0.0.1"])],
        ["localhost to both, IPv4 first", "localhost", answers(["127.0.0.1", "::1"])],
        ["localhost to an IPv6 spelling", "localhost", answers(["0:0:0:0:0:0:0:1"])],
        ["an IPv6 literal", "0:0:0:0:0:0:0:1", neverCalled],
        ["a bracketed IPv6 literal", "[::1]", neverCalled],
        ["an IPv4 literal", "10.0.4.7", neverCalled],
    ] as const) {
        outcomes[label] = await resolveListenHost(host, isLoopbackOrPrivateHost, lookup);
    }
    assert.deepEqual(outcomes, {
        "localhost to IPv4 only": { ok: true, address: "127.0.0.1" },
        "localhost to IPv6 only": { ok: true, address: "::1" },
        "localhost to both, IPv6 first": { ok: true, address: "::1" },
        "localhost to both, IPv4 first": { ok: true, address: "127.0.0.1" },
        "localhost to an IPv6 spelling": { ok: true, address: "::1" },
        "an IPv6 literal": { ok: true, address: "0:0:0:0:0:0:0:1" },
        "a bracketed IPv6 literal": { ok: true, address: "::1" },
        "an IPv4 literal": { ok: true, address: "10.0.4.7" },
    });
});

test("a host name that does not resolve, or resolves outside loopback and private ranges, is refused with the reason", async () => {
    const missing = await resolveListenHost("localhost", isLoopbackOrPrivateHost, unresolvable);
    assert.equal(missing.ok, false);
    assert.match(missing.ok ? "" : missing.problem, /BROWSER_SERVICE_HOST=localhost does not resolve on this host \(ENOTFOUND\)/);

    const empty = await resolveListenHost("localhost", isLoopbackOrPrivateHost, answers([]));
    assert.match(empty.ok ? "" : empty.problem, /resolves to no address/);

    const publicAnswer = await resolveListenHost("localhost", isLoopbackOrPrivateHost, answers(["127.0.0.1", "203.0.113.54"]));
    assert.match(publicAnswer.ok ? "" : publicAnswer.problem, /resolves to 203\.0\.113\.54, which is not a loopback or private address/);
});
