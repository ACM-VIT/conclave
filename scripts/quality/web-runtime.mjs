export function detectNextWebRuntime(html) {
  const source = typeof html === "string" ? html : "";
  if (
    /browser_dev_hmr-client|next-devtools|react-server-dom-turbopack/i.test(
      source,
    )
  ) {
    return "development";
  }
  if (/_next\/static\//i.test(source)) return "production";
  return "unknown";
}
