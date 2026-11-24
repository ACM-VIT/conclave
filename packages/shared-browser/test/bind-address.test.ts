import assert from "node:assert/strict";
import test from "node:test";
import { bindingCovers, canonicalHost, parseBindings } from "../src/bindAddress.js";

test("every spelling of one host has one canonical form", () => {
    const spellings: Array<[string, string[]]> = [
        ["::1", ["::1", "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001", "::0:1", "[::1]", " ::1 "]],
        ["127.0.0.1", ["127.0.0.1", "::ffff:127.0.0.1", "::FFFF:7f00:1", "[::ffff:127.0.0.1]", "0:0:0:0:0:ffff:7f00:1"]],
        ["fd00::12", ["fd00::12", "FD00:0:0:0:0:0:0:12", "[fd00::0012]"]],
        ["fe80::1%eth0", ["fe80::1%eth0", "FE80::0001%eth0", "[fe80:0:0:0:0:0:0:1%eth0]"]],
        ["::", ["::", "0:0:0:0:0:0:0:0", "[::]"]],
        ["0.0.0.0", ["0.0.0.0", "", "::ffff:0.0.0.0"]],
        ["localhost", ["localhost", "LOCALHOST"]],
    ];
    const seen = Object.fromEntries(spellings.map(([canonical, forms]) => [canonical, forms.map(canonicalHost)]));
    assert.deepEqual(seen, Object.fromEntries(spellings.map(([canonical, forms]) => [canonical, forms.map(() => canonical)])));
});

test("a bound address covers the listener it holds, and only on its own port", () => {
    const cases: Array<[string, string, boolean]> = [
        ["0:0:0:0:0:0:0:1|3040", "::1|3040", true],
        ["::ffff:127.0.0.1|3040", "127.0.0.1|3040", true],
        ["127.0.0.1|3040", "::ffff:7f00:1|3040", true],
        ["::|3040", "127.0.0.1|3040", true],
        ["::|3040", "fd00::12|3040", true],
        ["0:0:0:0:0:0:0:0|3040", "10.0.4.7|3040", true],
        ["0.0.0.0|3040", "10.0.4.7|3040", true],
        ["|3040", "127.0.0.1|3040", true],
        ["0.0.0.0|3040", "::1|3040", false],
        ["127.0.0.1|3040", "10.0.4.7|3040", false],
        ["::1|3040", "127.0.0.1|3040", false],
        ["fe80::1%eth0|3040", "fe80::1%eth1|3040", false],
        ["::|3040", "::1|3041", false],
    ];
    const outcomes = cases.map(([bound, listener]) => {
        const [boundAddress] = parseBindings(bound, 3040);
        const [listenerAddress] = parseBindings(listener, 3040);
        return `${bound} holds ${listener}: ${bindingCovers(boundAddress, listenerAddress)}`;
    });
    assert.deepEqual(outcomes, cases.map(([bound, listener, covers]) => `${bound} holds ${listener}: ${covers}`));
});

test("bindings arrive raw from the deploy scripts and are read with the service's defaults", () => {
    assert.deepEqual(parseBindings("0:0:0:0:0:0:0:1|3999,|,|4100,::ffff:10.0.0.5|4101,", 3040), [
        { host: "0:0:0:0:0:0:0:1", port: 3999 },
        { host: "", port: 3040 },
        { host: "", port: 4100 },
        { host: "::ffff:10.0.0.5", port: 4101 },
    ]);
    assert.deepEqual(parseBindings("", 3040), []);
    assert.deepEqual(parseBindings("127.0.0.1|not-a-port,127.0.0.1:3040", 3040), []);
});
