import dns from "node:dns";

const answer = process.env.FAKE_LOCALHOST_ADDRESSES ?? "";
const systemLookup = dns.promises.lookup.bind(dns.promises);

dns.promises.lookup = async (host, options) => {
    if (host.toLowerCase() !== "localhost") return systemLookup(host, options);
    if (answer === "") throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND", hostname: host });
    const addresses = answer.split(",").map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    return options?.all ? addresses : addresses[0];
};
