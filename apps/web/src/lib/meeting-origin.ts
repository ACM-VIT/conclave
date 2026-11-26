const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

export const webOrigin = (href: string): string | null => {
  try {
    const url = new URL(href);
    return /^https?:$/.test(url.protocol) && url.hostname ? url.origin : null;
  } catch {
    return null;
  }
};

const spelledAsTheUrlHost = (authority: string) => {
  let hostname: string;
  try {
    hostname = new URL(`https://${authority}/`).hostname;
  } catch {
    return false;
  }
  if (authority.startsWith("[")) return true;
  const typed = authority.toLowerCase().replace(/:\d*$/, "").split(".");
  const labels = hostname.split(".");
  return (
    typed.length === labels.length &&
    typed.every(
      (label, index) =>
        label === labels[index] ||
        (!PRINTABLE_ASCII.test(label) && labels[index].startsWith("xn--")),
    )
  );
};

export const linkOriginIsKnown = (
  scheme: string | undefined,
  authority: string,
  knownOrigins: readonly string[],
) => {
  const known = new Set(
    knownOrigins.map(webOrigin).filter((origin): origin is string => origin !== null),
  );
  if (scheme) {
    const origin = webOrigin(`${scheme}//${authority}/`);
    return origin !== null && known.has(origin);
  }
  if (!spelledAsTheUrlHost(authority)) return false;
  return [...known].some(
    (origin) => webOrigin(`${new URL(origin).protocol}//${authority}/`) === origin,
  );
};
