const getGlobalCrypto = () =>
  typeof globalThis !== "undefined" && globalThis.crypto ? globalThis.crypto : null;

let hasWarnedInsecureFallback = false;

const shim = {
  ensureSecure() {
  },
  getRandomValues(typedArray) {
    const crypto = getGlobalCrypto();
    if (crypto && typeof crypto.getRandomValues === "function") {
      return crypto.getRandomValues(typedArray);
    }

    if (!hasWarnedInsecureFallback && typeof console !== "undefined") {
      hasWarnedInsecureFallback = true;
      console.warn(
        "[mobile] crypto.getRandomValues is unavailable; using a non-cryptographic fallback."
      );
    }
    for (let i = 0; i < typedArray.length; i += 1) {
      typedArray[i] = Math.floor(Math.random() * 256);
    }
    return typedArray;
  },
  get subtle() {
    const crypto = getGlobalCrypto();
    return crypto?.subtle;
  },
};

module.exports = shim;
module.exports.default = shim;
