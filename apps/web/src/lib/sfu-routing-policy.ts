import { createHash } from "node:crypto";

export type SfuAvailability = "healthy" | "draining" | "unknown";
export type SfuRoomPlacementCapability = "supported" | "legacy" | "unknown";

export type SfuRoutingCandidate = {
  index: number;
  url: string;
  availability: SfuAvailability;
  instanceId?: string;
  region?: string;
  latencyMs?: number;
  roomPlacementCapability?: SfuRoomPlacementCapability;
};

export type PreOwnerSfuSelection =
  | {
      kind: "selected";
      candidate: SfuRoutingCandidate;
      alternatives: SfuRoutingCandidate[];
      availability: "healthy" | "unknown";
    }
  | { kind: "all-draining" }
  | { kind: "empty" };

export type SfuRoomAssignment = {
  kind?: "owner" | "placement";
  instanceId?: string;
  instanceUrl?: string;
  region?: string;
  expiresAt?: number;
};

export type SfuPlacementResponse = {
  registryMode?: "local" | "redis";
  local?: boolean;
  assignment?: SfuRoomAssignment | null;
};

export type ReservedSfuResolution =
  | { ok: true; url: string; assignment: SfuRoomAssignment }
  | {
      ok: false;
      reason: "invalid-assignment" | "unsafe-local-registry";
    };

export const resolveRoomPlacementCapability = (
  status: unknown,
): SfuRoomPlacementCapability => {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return "unknown";
  }

  const capabilities = (status as { capabilities?: unknown }).capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    // A valid status envelope without the capability marker is an SFU from
    // before the atomic placement endpoint was introduced.
    return "legacy";
  }

  return (capabilities as { roomPlacement?: unknown }).roomPlacement === 1
    ? "supported"
    : "legacy";
};

const pickStableCandidate = (
  candidates: readonly SfuRoutingCandidate[],
  routingKey: string,
): SfuRoutingCandidate | null => {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] ?? null;

  const ordered = [...candidates].sort((left, right) => left.index - right.index);
  const digest = createHash("sha256").update(routingKey).digest();
  return ordered[digest.readUInt32BE(0) % ordered.length] ?? null;
};

const NEAR_SFU_ABSOLUTE_BAND_MS = 20;
const NEAR_SFU_RELATIVE_BAND = 0.25;

const pickLatencyAwareStableCandidate = (
  candidates: readonly SfuRoutingCandidate[],
  routingKey: string,
): SfuRoutingCandidate | null => {
  const measured = candidates.filter(
    (candidate) =>
      typeof candidate.latencyMs === "number" &&
      Number.isFinite(candidate.latencyMs) &&
      candidate.latencyMs >= 0,
  );
  if (measured.length === 0) {
    return pickStableCandidate(candidates, routingKey);
  }

  const fastestLatencyMs = Math.min(
    ...measured.map((candidate) => candidate.latencyMs as number),
  );
  const materialBandMs = Math.max(
    NEAR_SFU_ABSOLUTE_BAND_MS,
    fastestLatencyMs * NEAR_SFU_RELATIVE_BAND,
  );
  const near = measured.filter(
    (candidate) =>
      (candidate.latencyMs as number) <= fastestLatencyMs + materialBandMs,
  );
  return pickStableCandidate(near, routingKey);
};

const orderAlternativeCandidates = (
  candidates: readonly SfuRoutingCandidate[],
  selected: SfuRoutingCandidate,
): SfuRoutingCandidate[] =>
  candidates
    .filter((candidate) => candidate.index !== selected.index)
    .sort((left, right) => {
      const leftLatency = left.latencyMs ?? Number.POSITIVE_INFINITY;
      const rightLatency = right.latencyMs ?? Number.POSITIVE_INFINITY;
      return leftLatency - rightLatency || left.index - right.index;
    });

export const selectPreOwnerSfu = (
  candidates: readonly SfuRoutingCandidate[],
  routingKey: string,
): PreOwnerSfuSelection => {
  const healthy = candidates.filter(
    (candidate) => candidate.availability === "healthy",
  );
  const healthyCandidate = pickLatencyAwareStableCandidate(healthy, routingKey);
  if (healthyCandidate) {
    return {
      kind: "selected",
      candidate: healthyCandidate,
      alternatives: orderAlternativeCandidates(healthy, healthyCandidate),
      availability: "healthy",
    };
  }

  // An unknown instance may still be reachable by the client. Prefer it over
  // an instance that explicitly reported that it will reject new rooms.
  const unknown = candidates.filter(
    (candidate) => candidate.availability === "unknown",
  );
  const unknownCandidate = pickStableCandidate(unknown, routingKey);
  if (unknownCandidate) {
    return {
      kind: "selected",
      candidate: unknownCandidate,
      alternatives: orderAlternativeCandidates(unknown, unknownCandidate),
      availability: "unknown",
    };
  }

  if (
    candidates.length > 0 &&
    candidates.every((candidate) => candidate.availability === "draining")
  ) {
    return { kind: "all-draining" };
  }

  return { kind: "empty" };
};

const normalizeHttpOrigin = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
};

export const resolveConfiguredOwnerSfuUrl = (
  ownerUrl: unknown,
  candidateSfuUrls: readonly string[],
): string | null => {
  const ownerOrigin = normalizeHttpOrigin(ownerUrl);
  if (!ownerOrigin) return null;

  for (const candidateSfuUrl of candidateSfuUrls) {
    const candidateOrigin = normalizeHttpOrigin(candidateSfuUrl);
    if (candidateOrigin === ownerOrigin) {
      // Return the trusted configured origin, not an owner-controlled path,
      // query, fragment, or spelling of the same origin.
      return candidateOrigin;
    }
  }

  return null;
};

export const resolveReservedSfuUrl = (options: {
  response: SfuPlacementResponse;
  selectedCandidate: SfuRoutingCandidate;
  candidateSfuUrls: readonly string[];
}): ReservedSfuResolution => {
  const { response, selectedCandidate, candidateSfuUrls } = options;
  const assignment = response.assignment;
  if (
    !assignment ||
    typeof assignment.instanceId !== "string" ||
    !assignment.instanceId.trim()
  ) {
    return { ok: false, reason: "invalid-assignment" };
  }

  if (candidateSfuUrls.length > 1 && response.registryMode !== "redis") {
    return { ok: false, reason: "unsafe-local-registry" };
  }

  const configuredAssignmentUrl = resolveConfiguredOwnerSfuUrl(
    assignment.instanceUrl,
    candidateSfuUrls,
  );
  if (configuredAssignmentUrl) {
    return { ok: true, url: configuredAssignmentUrl, assignment };
  }

  if (
    response.local === true &&
    (!selectedCandidate.instanceId ||
      assignment.instanceId === selectedCandidate.instanceId)
  ) {
    return { ok: true, url: selectedCandidate.url, assignment };
  }

  return { ok: false, reason: "invalid-assignment" };
};
