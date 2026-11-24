const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

export const comparableHost = (host: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(`https://${host}/`);
  } catch {
    return null;
  }
  const typedLabels = host.toLowerCase().replace(/:\d*$/, "").split(".");
  const labels = parsed.hostname.split(".");
  const onlyCaseOrIdn =
    typedLabels.length === labels.length &&
    typedLabels.every(
      (label, index) =>
        label === labels[index] ||
        (!PRINTABLE_ASCII.test(label) && labels[index].startsWith("xn--")),
    );
  if (!onlyCaseOrIdn) return null;
  return parsed.port && parsed.port !== "80"
    ? `${parsed.hostname}:${parsed.port}`
    : parsed.hostname;
};
