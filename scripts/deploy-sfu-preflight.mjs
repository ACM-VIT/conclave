#!/usr/bin/env node

import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

const REGION_PATTERN = /^[a-z0-9](?:[a-z0-9._:-]{0,62}[a-z0-9])?$/;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const DEFAULT_TIMEOUT_MS = 5_000;

export class SfuDeployPreflightError extends Error {
  constructor(errors) {
    super(`SFU deployment preflight failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
    this.name = "SfuDeployPreflightError";
    this.errors = errors;
  }
}

const parseEnvironment = (environment) => {
  if (!environment) return {};
  if (!Array.isArray(environment)) return environment;

  return Object.fromEntries(
    environment.map((entry) => {
      const separator = entry.indexOf("=");
      return separator < 0
        ? [entry, ""]
        : [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
};

const parseRequiredPort = (value, label, errors) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    errors.push(`${label} must be an integer from 1 through 65535.`);
    return null;
  }
  return parsed;
};

const IPV4_MAPPED_PATTERN = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/** Canonical IP literal, with IPv4-mapped IPv6 (::ffff:a.b.c.d) unwrapped to IPv4. */
const canonicalIp = (value) => {
  if (isIP(value) !== 6) return value;
  const canonical = new URL(`http://[${value}]`).hostname.slice(1, -1);
  const mapped = IPV4_MAPPED_PATTERN.exec(canonical);
  if (!mapped) return canonical;
  const [high, low] = [mapped[1], mapped[2]].map((group) => Number.parseInt(group, 16));
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
};

const isLoopbackIp = (value) => {
  const ip = canonicalIp(value);
  if (ip === "::1") return true;
  if (isIP(ip) !== 4) return false;
  return Number(ip.split(".")[0]) === 127;
};

const isPublicIpv4 = (value) => {
  const octets = value.split(".").map(Number);
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
};

/** Global unicast is 2000::/3. Canonical IPv6 drops leading zeros, so compare the first hextet as a number. */
const isPublicIpv6 = (canonical) => {
  const firstHextet = Number.parseInt(canonical.split(":", 1)[0] || "0", 16);
  return (firstHextet & 0xe000) === 0x2000;
};

const isPublicIp = (value) => {
  const ip = canonicalIp(value);
  const version = isIP(ip);
  if (version === 4) return isPublicIpv4(ip);
  if (version === 6) return isPublicIpv6(ip);
  return false;
};

const isLocalUrl = (url) =>
  url.hostname === "localhost" || isLoopbackIp(url.hostname.replace(/^\[|\]$/g, ""));

const parsePublicUrl = (value, service, errors) => {
  if (!value?.trim()) {
    errors.push(`${service}: SFU_PUBLIC_URL is required.`);
    return null;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push(`${service}: SFU_PUBLIC_URL must be an absolute HTTP(S) URL.`);
    return null;
  }

  if (!(["http:", "https:"].includes(url.protocol))) {
    errors.push(`${service}: SFU_PUBLIC_URL must use HTTP or HTTPS.`);
  }
  if (url.username || url.password) {
    errors.push(`${service}: SFU_PUBLIC_URL must not contain credentials.`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    errors.push(`${service}: SFU_PUBLIC_URL must be a direct origin without a path, query, or fragment.`);
  }
  if (!isLocalUrl(url) && url.protocol !== "https:") {
    errors.push(`${service}: a non-local SFU_PUBLIC_URL must use HTTPS.`);
  }

  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
};

/**
 * Redis carries room placement and the Socket.IO adapter. Only a Redis on this
 * host's loopback may skip TLS and credentials; anything else must use both,
 * and a public IP is refused unless the operator explicitly allows it.
 */
const checkRedisExposure = (url, service, errors, allowPublicRedis) => {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host.toLowerCase() === "localhost" || isLoopbackIp(host)) return;

  if (url.protocol !== "rediss:") {
    errors.push(`${service}: a Redis that is not on loopback must use TLS (rediss://).`);
  }
  if (!url.password) {
    errors.push(`${service}: a Redis that is not on loopback must require credentials in the URL.`);
  }
  if (isPublicIp(host) && !allowPublicRedis) {
    errors.push(
      `${service}: Redis at public IP ${host} is refused. Use a private address, or set SFU_DEPLOY_ALLOW_PUBLIC_REDIS=1 if it is firewalled to the SFU hosts.`,
    );
  }
};

const normalizeRedisRegistry = (value, service, errors, allowPublicRedis) => {
  if (!value?.trim()) {
    errors.push(`${service}: SFU_REDIS_URL or REDIS_URL is required.`);
    return null;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
      errors.push(`${service}: the shared registry URL must use redis:// or rediss://.`);
      return null;
    }
    if (!url.hostname) {
      errors.push(`${service}: the shared registry URL must include a host.`);
      return null;
    }
    checkRedisExposure(url, service, errors, allowPublicRedis);
    const port = url.port || "6379";
    const database = !url.pathname || url.pathname === "/" ? "/0" : url.pathname;
    url.searchParams.sort();
    return `${url.protocol}//${url.hostname.toLowerCase()}:${port}${database}${url.search}`;
  } catch {
    errors.push(`${service}: SFU_REDIS_URL or REDIS_URL is not a valid URL.`);
    return null;
  }
};

/**
 * Mirrors the SFU's production startup checks (server/cors.ts), so a value the
 * new container would refuse to boot with fails here, before the live
 * instance starts draining.
 */
const checkProductionMode = (env, service, errors) => {
  if (String(env.NODE_ENV || "").trim() !== "production") {
    errors.push(`${service}: NODE_ENV must be production.`);
    return;
  }
  const origins = String(env.SFU_CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0 || origins.includes("*")) {
    if (env.SFU_ALLOW_OPEN_CORS !== "1") {
      errors.push(`${service}: SFU_CORS_ORIGINS must list the web app origins; the SFU will not start in production without it.`);
    }
    return;
  }
  for (const origin of origins) {
    let protocol = "";
    try {
      protocol = new URL(origin).protocol;
    } catch {
      protocol = "";
    }
    if (protocol !== "http:" && protocol !== "https:") {
      errors.push(`${service}: SFU_CORS_ORIGINS entry ${JSON.stringify(origin)} is not an http(s) origin.`);
    }
  }
};

const isRequiredRedisMode = (value) =>
  value === true || value === 1 || String(value).trim().toLowerCase() === "true" || String(value).trim() === "1";

export const resolveSfuTargets = ({ allowPublicRedis = false, compose, serviceNames }) => {
  const services = compose?.services;
  if (!services || typeof services !== "object") {
    throw new SfuDeployPreflightError(["Rendered compose JSON has no services object."]);
  }

  const selectedNames = serviceNames?.length
    ? serviceNames
    : Object.entries(services)
        .filter(([, service]) => parseEnvironment(service.environment).SFU_INSTANCE_ID)
        .map(([name]) => name);
  const errors = [];
  if (selectedNames.length === 0) {
    errors.push("No SFU services were found. Set SFU_DEPLOY_SERVICES when service names are not discoverable.");
  }

  const targets = [];
  for (const service of selectedNames) {
    const definition = services[service];
    if (!definition) {
      errors.push(`${service}: service is absent from rendered compose configuration.`);
      continue;
    }
    const env = parseEnvironment(definition.environment);
    const instanceId = String(env.SFU_INSTANCE_ID || "").trim();
    const region = String(env.SFU_REGION || "").trim();
    const publicUrl = parsePublicUrl(String(env.SFU_PUBLIC_URL || ""), service, errors);
    const announcedIpInput = String(env.ANNOUNCED_IP || "").trim();
    const announcedIp = canonicalIp(announcedIpInput);
    const rtcMinPort = parseRequiredPort(env.RTC_MIN_PORT, `${service}: RTC_MIN_PORT`, errors);
    const rtcMaxPort = parseRequiredPort(env.RTC_MAX_PORT, `${service}: RTC_MAX_PORT`, errors);
    const serverPort = parseRequiredPort(env.SFU_PORT || env.PORT, `${service}: SFU_PORT`, errors);
    const redisRegistry = normalizeRedisRegistry(
      String(env.SFU_REDIS_URL || env.REDIS_URL || ""),
      service,
      errors,
      allowPublicRedis,
    );

    if (!INSTANCE_ID_PATTERN.test(instanceId)) {
      errors.push(`${service}: SFU_INSTANCE_ID must be a stable 1-128 character identifier.`);
    }
    if (!REGION_PATTERN.test(region)) {
      errors.push(`${service}: SFU_REGION must be a lowercase 1-64 character region identifier.`);
    }
    if (!isRequiredRedisMode(env.SFU_REQUIRE_REDIS_ADAPTER)) {
      errors.push(`${service}: SFU_REQUIRE_REDIS_ADAPTER must be 1 or true.`);
    }
    if (isIP(announcedIpInput) === 0) {
      errors.push(`${service}: ANNOUNCED_IP must be an IP literal.`);
    } else if (publicUrl && !isLocalUrl(publicUrl) && !isPublicIp(announcedIpInput)) {
      errors.push(`${service}: ANNOUNCED_IP must be a publicly routable IP for a non-local public URL.`);
    }
    if (rtcMinPort !== null && rtcMaxPort !== null && rtcMaxPort < rtcMinPort) {
      errors.push(`${service}: RTC_MAX_PORT must be greater than or equal to RTC_MIN_PORT.`);
    }
    if (!String(env.SFU_SECRET || "").trim() || env.SFU_SECRET === "development-secret") {
      errors.push(`${service}: SFU_SECRET must be a non-default value.`);
    }
    checkProductionMode(env, service, errors);

    targets.push({
      announcedIp,
      instanceId,
      publicUrl,
      redisRegistry,
      region,
      rtcMaxPort,
      rtcMinPort,
      secret: String(env.SFU_SECRET || ""),
      serverPort,
      service,
    });
  }

  const byInstanceId = new Map();
  const byPublicUrl = new Map();
  for (const target of targets) {
    const normalizedId = target.instanceId.toLowerCase();
    if (normalizedId) {
      const previous = byInstanceId.get(normalizedId);
      if (previous) {
        errors.push(`${target.service}: SFU_INSTANCE_ID duplicates ${previous}: ${target.instanceId}.`);
      } else {
        byInstanceId.set(normalizedId, target.service);
      }
    }

    if (target.publicUrl) {
      const publicOrigin = target.publicUrl.origin.toLowerCase();
      const previous = byPublicUrl.get(publicOrigin);
      if (previous) {
        errors.push(`${target.service}: SFU_PUBLIC_URL duplicates ${previous}: ${target.publicUrl.origin}.`);
      } else {
        byPublicUrl.set(publicOrigin, target.service);
      }
    }
  }

  const registries = new Set(targets.map((target) => target.redisRegistry).filter(Boolean));
  if (registries.size > 1) {
    errors.push("SFU services do not use the same Redis registry endpoint and database.");
  }
  const secrets = new Set(targets.map((target) => target.secret).filter(Boolean));
  if (secrets.size > 1) {
    errors.push("SFU services do not share the same SFU_SECRET.");
  }

  for (let leftIndex = 0; leftIndex < targets.length; leftIndex += 1) {
    const left = targets[leftIndex];
    if (left.rtcMinPort === null || left.rtcMaxPort === null) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < targets.length; rightIndex += 1) {
      const right = targets[rightIndex];
      if (
        left.announcedIp !== right.announcedIp ||
        right.rtcMinPort === null ||
        right.rtcMaxPort === null
      ) {
        continue;
      }
      const overlaps = left.rtcMinPort <= right.rtcMaxPort && right.rtcMinPort <= left.rtcMaxPort;
      if (overlaps) {
        errors.push(
          `${left.service} and ${right.service}: RTC port ranges overlap on ${left.announcedIp}.`,
        );
      }
    }
  }

  if (errors.length > 0) throw new SfuDeployPreflightError(errors);
  return targets;
};

const readJsonResponse = async ({ fetchImpl, url, headers, timeoutMs }) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(url, {
      headers,
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
};

const probeTarget = async ({ target, fetchImpl, timeoutMs }) => {
  const errors = [];
  const healthUrl = new URL("health", target.publicUrl);
  const statusUrl = new URL("status", target.publicUrl);
  let health;
  let status;

  try {
    health = await readJsonResponse({ fetchImpl, url: healthUrl, headers: {}, timeoutMs });
  } catch (error) {
    errors.push(`${target.service}: ${healthUrl.href} failed: ${error.message}.`);
  }

  try {
    status = await readJsonResponse({
      fetchImpl,
      url: statusUrl,
      headers: { "x-sfu-secret": target.secret },
      timeoutMs,
    });
  } catch (error) {
    errors.push(`${target.service}: ${statusUrl.href} failed: ${error.message}.`);
  }

  if (health) {
    if (health.status !== "healthy") {
      errors.push(`${target.service}: /health reported '${health.status || "unknown"}'.`);
    }
    if (!Number.isInteger(health.workers?.healthy) || health.workers.healthy < 1) {
      errors.push(`${target.service}: /health reported no healthy mediasoup workers.`);
    }
    if (health.port !== target.serverPort) {
      errors.push(
        `${target.service}: /health port ${health.port ?? "unknown"} does not match configured SFU_PORT ${target.serverPort}.`,
      );
    }
  }

  if (status) {
    if (status.instanceId !== target.instanceId) {
      errors.push(
        `${target.service}: public route returned instance '${status.instanceId || "unknown"}', expected '${target.instanceId}'.`,
      );
    }
    if (status.region !== target.region) {
      errors.push(
        `${target.service}: public route returned region '${status.region || "unknown"}', expected '${target.region}'.`,
      );
    }
  }

  return { errors, health, status, target };
};

export const runSfuDeployPreflight = async ({
  allowPublicRedis = false,
  compose,
  configOnly = false,
  fetchImpl = globalThis.fetch,
  serviceNames,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) => {
  const targets = resolveSfuTargets({ allowPublicRedis, compose, serviceNames });
  if (configOnly) return { configOnly: true, probes: [], targets };
  if (typeof fetchImpl !== "function") {
    throw new SfuDeployPreflightError(["This Node.js runtime does not provide fetch()."]);
  }

  const probes = await Promise.all(
    targets.map((target) => probeTarget({ target, fetchImpl, timeoutMs })),
  );
  const errors = probes.flatMap((probe) => probe.errors);
  if (errors.length > 0) throw new SfuDeployPreflightError(errors);
  return { configOnly: false, probes, targets };
};

const parseCli = (argv) => {
  const options = { composeJson: "-", configOnly: false, serviceNames: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--compose-json") {
      options.composeJson = argv[++index];
    } else if (argument === "--services") {
      options.serviceNames = argv[++index]
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    } else if (argument === "--config-only") {
      options.configOnly = true;
    } else if (argument === "--timeout-ms") {
      options.timeoutMs = Number(argv[++index]);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!options.composeJson) throw new Error("--compose-json requires a file path or '-'.");
  if (
    options.timeoutMs !== undefined &&
    (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 60_000)
  ) {
    throw new Error("--timeout-ms must be an integer from 100 through 60000.");
  }
  return options;
};

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const main = async () => {
  try {
    const options = parseCli(process.argv.slice(2));
    const rawCompose =
      options.composeJson === "-"
        ? await readStdin()
        : await readFile(options.composeJson, "utf8");
    const compose = JSON.parse(rawCompose);
    const result = await runSfuDeployPreflight({
      allowPublicRedis: process.env.SFU_DEPLOY_ALLOW_PUBLIC_REDIS === "1",
      compose,
      configOnly: options.configOnly,
      serviceNames: options.serviceNames,
      timeoutMs: options.timeoutMs,
    });
    const mode = result.configOnly ? "configuration" : "configuration and live routes";
    console.log(`SFU deployment preflight passed (${mode}; ${result.targets.length} service(s)).`);
    for (const target of result.targets) {
      console.log(
        `- ${target.service}: ${target.instanceId} / ${target.region} / ${target.publicUrl.origin} / UDP ${target.rtcMinPort}-${target.rtcMaxPort}`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
