import { describe, expect, it } from "vitest";
import { isPrivateHostname } from "../server/socket/handlers/sharedBrowserHandlers.js";

const hostOf = (url: string) => new URL(url).hostname;

describe("shared browser private address filter", () => {
  it.each([
    "http://[::ffff:169.254.169.254]/latest/meta-data/",
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:10.0.0.5]/",
    "http://[::]/",
    "http://[::1]/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://[fe90::1]/",
    "http://[fd00::1]/",
    "http://host.docker.internal:3040/launch",
    "http://metadata.google.internal/",
    "http://100.64.1.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://169.254.169.254/",
    "http://printer.home.arpa/",
  ])("blocks %s", (url) => {
    expect(isPrivateHostname(hostOf(url))).toBe(true);
  });

  it.each([
    "https://example.com/",
    "https://8.8.8.8/",
    "http://[2606:4700:4700::1111]/",
    "https://docs.internal-tools.example.com/",
  ])("allows %s", (url) => {
    expect(isPrivateHostname(hostOf(url))).toBe(false);
  });
});
