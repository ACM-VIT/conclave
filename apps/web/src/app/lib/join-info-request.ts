import { stampRelayLifetime } from "./relay-credentials";
import { readResponseError } from "./utils";

export type JoinInfoAnswer = {
  token: string;
  sfuUrl: string;
  iceServers?: RTCIceServer[];
  iceServersTtlSeconds?: number;
  /**
   * When the TURN credentials run out on this device's clock, counted from
   * when the request was sent. The route issues them after that moment, so
   * this is never late, and it needs no agreement between the two clocks.
   */
  relayExpiresAt?: number;
  relayIssuedAt?: number;
};

export const JOIN_INFO_REQUEST_TIMEOUT_MS = 15000;

const readJoinInfo = async (
  response: Response,
  sentAt: number,
): Promise<JoinInfoAnswer> => {
  if (!response.ok) {
    const error = new Error(await readResponseError(response)) as Error & {
      responseStatus?: number;
    };
    error.responseStatus = response.status;
    throw error;
  }
  return stampRelayLifetime((await response.json()) as JoinInfoAnswer, sentAt);
};

/**
 * Asks the join route for an answer. The timeout and the caller's signal
 * cover the whole answer, body included, so a response that stalls after its
 * headers cannot hold up a join or a reconnect.
 */
export const requestJoinInfo = async (
  url: string,
  init: RequestInit,
  {
    signal: cancel,
    timeoutMs = JOIN_INFO_REQUEST_TIMEOUT_MS,
  }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<JoinInfoAnswer> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (cancel?.aborted) abort();
  cancel?.addEventListener("abort", abort, { once: true });
  try {
    const sentAt = Date.now();
    return await readJoinInfo(
      await fetch(url, { ...init, signal: controller.signal }),
      sentAt,
    );
  } catch (error) {
    if (cancel?.aborted) throw new Error("Join info request was cancelled");
    if (controller.signal.aborted) {
      throw new Error("Join info request timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    cancel?.removeEventListener("abort", abort);
  }
};
