const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

export const canonicalHost = (host: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(`https://${host}/`);
  } catch {
    return null;
  }
  return parsed.port && parsed.port !== "80"
    ? `${parsed.hostname}:${parsed.port}`
    : parsed.hostname;
};

export const canonicalTypedHost = (host: string): string | null => {
  const canonical = canonicalHost(host);
  if (!canonical || host.startsWith("[")) return canonical;
  const typedLabels = host.toLowerCase().replace(/:\d*$/, "").split(".");
  const labels = canonical.replace(/:\d+$/, "").split(".");
  const onlyCaseOrIdn =
    typedLabels.length === labels.length &&
    typedLabels.every(
      (label, index) =>
        label === labels[index] ||
        (!PRINTABLE_ASCII.test(label) && labels[index].startsWith("xn--")),
    );
  return onlyCaseOrIdn ? canonical : null;
};
