/**
 * An error whose message the server wrote, such as a socket ack's `error`.
 * That text can carry words people typed (a host's end-room note), so
 * telemetry keeps the type and drops the message.
 */
export class ServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerError";
  }
}
