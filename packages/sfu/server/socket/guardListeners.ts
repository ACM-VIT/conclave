import type { Socket } from "socket.io";
import { Logger } from "../../utilities/loggers.js";

type Listener = (...args: unknown[]) => unknown;

const INTERNAL_ERROR = { error: "Internal server error" };

const answerFailedAck = (args: unknown[]): void => {
  const ack = args[args.length - 1];
  if (typeof ack !== "function") return;
  try {
    // socket.io ignores a second call to an ack, so this only answers a
    // client the failed handler left waiting.
    (ack as (response: unknown) => void)(INTERNAL_ERROR);
  } catch {}
};

/**
 * Makes every listener registered on this socket fail safe.
 *
 * socket.io runs listeners with no error handling, and the process treats any
 * uncaught exception or unhandled rejection as fatal (see redisErrors.ts). A
 * single malformed packet that made one handler throw (a missing ack
 * callback, a null payload destructured before validation) therefore took
 * down the whole SFU and every room on it. Errors are now logged and answered
 * on the event's ack instead.
 */
export const guardSocketListeners = (socket: Socket): void => {
  const register = socket.on.bind(socket) as (
    event: string,
    listener: Listener,
  ) => Socket;
  const guarded = (event: string, listener: Listener): Socket =>
    register(event, (...args: unknown[]) => {
      const fail = (error: unknown) => {
        Logger.error(`[Socket] Handler for "${event}" failed (${socket.id})`, error);
        answerFailedAck(args);
      };
      try {
        const result = listener(...args);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          (result as Promise<unknown>).then(undefined, fail);
        }
      } catch (error) {
        fail(error);
      }
    });
  socket.on = guarded as unknown as Socket["on"];
};
