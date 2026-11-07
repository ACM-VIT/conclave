import type { Socket } from "socket.io-client";

/**
 * Emits with an acknowledgement callback (the last argument), but calls
 * `onLost` instead when the server does not answer within `timeoutMs` or the
 * socket drops first. socket.io drops plain ack callbacks on disconnect, so a
 * promise resolved only from one never settles, and any busy flag waiting on
 * it stays on forever.
 */
export const emitWithAckTimeout = (
  socket: Pick<Socket, "timeout">,
  timeoutMs: number,
  onLost: () => void,
  event: string,
  ...argsAndAck: unknown[]
): void => {
  const ack = argsAndAck[argsAndAck.length - 1];
  if (typeof ack !== "function") {
    throw new TypeError(`${event}: the last argument must be the ack callback`);
  }
  const payload = argsAndAck.slice(0, -1);
  socket
    .timeout(timeoutMs)
    .emit(event, ...payload, (error: Error | null, ...responses: unknown[]) => {
      if (error) {
        console.warn(`[Meets] ${event} got no acknowledgement`, error);
        onLost();
        return;
      }
      (ack as (...responses: unknown[]) => void)(...responses);
    });
};
