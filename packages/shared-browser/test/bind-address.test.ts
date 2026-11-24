import assert from "node:assert/strict";
import test from "node:test";
import {
    bindingCovers,
    canonicalLiteral,
    parseBindings,
    resolveBindings,
    resolveHost,
    resolveListenHost,
    type Lookup,
    type ResolvedHost,
} from "../src/bindAddress.js";
import { isLoopbackOrPrivateHost } from "../src/serviceSecurity.js";

const resolver = (table: Record<string, string[]>): Lookup => async (host) => {
    const answers = table[host];
    if (!answers) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return answers.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};
const neverLooksUp: Lookup = async () => {
    throw new Error("an address literal must not be looked up");
};

test("every spelling of one address has one canonical form, and a name is not an address", () => {
    const spellings: Array<[string | null, string[]]> = [
        ["::1", ["::1", "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001", "::0:1", "[::1]", " ::1 "]],
        ["127.0.0.1", ["127.0.0.1", "::ffff:127.0.0.1", "::FFFF:7f00:1", "[::ffff:127.0.0.1]", "0:0:0:0:0:ffff:7f00:1"]],
        ["fd00::12", ["fd00::12", "FD00:0:0:0:0:0:0:12", "[fd00::0012]"]],
        ["fe80::1%eth0", ["fe80::1%eth0", "FE80::0001%eth0", "[fe80:0:0:0:0:0:0:1%eth0]"]],
        ["::", ["::", "0:0:0:0:0:0:0:0", "[::]"]],
        ["0.0.0.0", ["0.0.0.0", "::ffff:0.0.0.0"]],
        [null, ["localhost", "LOCALHOST", "browser.internal", ""]],
    ];
    const seen = spellings.map(([canonical, forms]) => [canonical, forms.map(canonicalLiteral)]);
    assert.deepEqual(seen, spellings.map(([canonical, forms]) => [canonical, forms.map(() => canonical)]));
});

test("a setting resolves to the address a service would bind: literals as written, names to their first answer", async () => {
    const lookup = resolver({ localhost: ["::1", "127.0.0.1"], "v4.internal": ["10.0.4.7"], "spelled.internal": ["0:0:0:0:0:0:0:1"] });
    const outcomes: Record<string, unknown> = {};
    for (const host of ["localhost", "v4.internal", "spelled.internal", "0:0:0:0:0:0:0:1", "[::ffff:127.0.0.1]", "", "missing.internal"]) {
        outcomes[host] = await resolveHost(host, host === "localhost" || host.endsWith(".internal") ? lookup : neverLooksUp);
    }
    assert.deepEqual(outcomes, {
        localhost: { ok: true, host: "::1", answers: ["::1", "127.0.0.1"] },
        "v4.internal": { ok: true, host: "10.0.4.7", answers: ["10.0.4.7"] },
        "spelled.internal": { ok: true, host: "::1", answers: ["::1"] },
        "0:0:0:0:0:0:0:1": { ok: true, host: "::1", answers: ["::1"] },
        "[::ffff:127.0.0.1]": { ok: true, host: "127.0.0.1", answers: ["127.0.0.1"] },
        "": { ok: true, host: "0.0.0.0", answers: ["0.0.0.0"] },
        "missing.internal": { ok: false, failure: "unresolved", code: "ENOTFOUND" },
    });
});

test("the listen setting is refused, with the reason, when it does not resolve or resolves outside loopback and private ranges", async () => {
    const outcomes: Record<string, unknown> = {};
    for (const [label, answers] of [
        ["IPv4 only", ["127.0.0.1"]],
        ["IPv6 only", ["::1"]],
        ["both, IPv6 first", ["::1", "127.0.0.1"]],
        ["both, IPv4 first", ["127.0.0.1", "::1"]],
        ["a public answer", ["127.0.0.1", "203.0.113.54"]],
        ["no answer", []],
    ] as const) {
        outcomes[label] = await resolveListenHost("localhost", isLoopbackOrPrivateHost, resolver({ localhost: [...answers] }));
    }
    outcomes.unresolved = await resolveListenHost("localhost", isLoopbackOrPrivateHost, resolver({}));
    assert.deepEqual(outcomes, {
        "IPv4 only": { ok: true, address: "127.0.0.1" },
        "IPv6 only": { ok: true, address: "::1" },
        "both, IPv6 first": { ok: true, address: "::1" },
        "both, IPv4 first": { ok: true, address: "127.0.0.1" },
        "a public answer": {
            ok: false,
            problem:
                "BROWSER_SERVICE_HOST=localhost resolves to 203.0.113.54, which is not a loopback or private address. Bind the control API to 127.0.0.1 or the private address the SFU reaches it on.",
        },
        "no answer": { ok: false, problem: "BROWSER_SERVICE_HOST=localhost resolves to no address. Set it to an address." },
        unresolved: {
            ok: false,
            problem: "BROWSER_SERVICE_HOST=localhost does not resolve on this host (ENOTFOUND). Set it to an address, or to a name this host resolves.",
        },
    });
});

test("bindings arrive raw from the deploy scripts and are read with the service's defaults", () => {
    assert.deepEqual(parseBindings("0:0:0:0:0:0:0:1|3999,|,|4100,localhost|4101,", 3040), [
        { host: "0:0:0:0:0:0:0:1", port: 3999 },
        { host: "", port: 3040 },
        { host: "", port: 4100 },
        { host: "localhost", port: 4101 },
    ]);
    assert.deepEqual(parseBindings("", 3040), []);
    assert.deepEqual(parseBindings("127.0.0.1|not-a-port,127.0.0.1:3040", 3040), []);
});

type Address = { text: string; family: 4 | 6; wildcard: boolean; spellings: string[] };

const addresses: Address[] = [
    { text: "127.0.0.1", family: 4, wildcard: false, spellings: ["127.0.0.1", "::ffff:127.0.0.1", "::FFFF:7f00:1", "[::ffff:127.0.0.1]"] },
    { text: "10.0.4.7", family: 4, wildcard: false, spellings: ["10.0.4.7", "::ffff:10.0.4.7", "::ffff:a00:407"] },
    { text: "192.168.1.20", family: 4, wildcard: false, spellings: ["192.168.1.20", "::ffff:c0a8:114", "[::ffff:192.168.1.20]"] },
    { text: "::1", family: 6, wildcard: false, spellings: ["::1", "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001", "[::1]", "::0:1"] },
    { text: "fd00::12", family: 6, wildcard: false, spellings: ["fd00::12", "FD00::12", "fd00:0:0:0:0:0:0:12", "[fd00::0012]"] },
    { text: "fd00::abcd", family: 6, wildcard: false, spellings: ["fd00::abcd", "FD00::ABCD", "fd00:0000::abcd"] },
    { text: "0.0.0.0", family: 4, wildcard: true, spellings: ["0.0.0.0", "", "::ffff:0.0.0.0"] },
    { text: "::", family: 6, wildcard: true, spellings: ["::", "0:0:0:0:0:0:0:0", "[::]"] },
];

const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};

test("an old binding holds the new listener exactly when both name the same effective listener", async () => {
    const next = random(20261124);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
    const listenable = addresses.filter((address) => !address.wildcard);
    const failures: string[] = [];
    const seen = { held: 0, refused: 0, byName: 0 };
    for (let run = 0; run < 3000; run += 1) {
        const table: Record<string, string[]> = {};
        const effective = (setting: string): Address => {
            const spelling = setting in table ? table[setting][0] : setting;
            return addresses.find((address) => address.spellings.includes(spelling))!;
        };
        const setting = (address: Address, side: string): string => {
            if (address.wildcard || next() < 0.6) return pick(address.spellings);
            const name = pick(["localhost", `${side}-${run}.internal`, "shared.internal"]);
            if (!table[name]) table[name] = [pick(address.spellings), ...(next() < 0.5 ? [pick(listenable).text] : [])];
            return name;
        };
        const listener = pick(listenable);
        const newSetting = setting(listener, "new");
        const newResolution = await resolveHost(newSetting, resolver(table));
        if (!newResolution.ok) {
            failures.push(`new ${JSON.stringify(newSetting)} answers ${JSON.stringify(table)} did not resolve`);
            continue;
        }
        const effectiveListener = effective(newSetting);
        const old = pick(addresses);
        const unresolvable = next() < 0.05;
        const oldSetting = unresolvable ? `gone-${run}.internal` : setting(old, "old");
        const effectiveOld = unresolvable ? old : effective(oldSetting);
        const oldPort = next() < 0.85 ? 3040 : 3041;
        const expected =
            !unresolvable &&
            oldPort === 3040 &&
            (effectiveOld.text === "::" || (effectiveOld.text === "0.0.0.0" && effectiveListener.family === 4) || effectiveOld.text === effectiveListener.text);
        const bound = await resolveBindings([{ host: oldSetting, port: oldPort }], resolver(table));
        const actual = bound.some((binding) => bindingCovers(binding, { host: newResolution.host, port: 3040 }));
        if (expected) seen.held += 1;
        else seen.refused += 1;
        if (oldSetting in table || newSetting in table) seen.byName += 1;
        if (actual !== expected) {
            failures.push(`old ${JSON.stringify(oldSetting)}:${oldPort} new ${JSON.stringify(newSetting)} answers ${JSON.stringify(table)}: expected ${expected}, got ${actual}`);
        }
    }
    assert.deepEqual(failures.slice(0, 5), []);
    assert.ok(seen.held > 300 && seen.refused > 300 && seen.byName > 1000, JSON.stringify(seen));
});

test("an old binding whose name no longer resolves proves nothing", async () => {
    const listener = { host: "127.0.0.1" as ResolvedHost, port: 3040 };
    const bound = await resolveBindings([{ host: "retired.internal", port: 3040 }], resolver({}));
    assert.equal(bound.some((binding) => bindingCovers(binding, listener)), false);
});
