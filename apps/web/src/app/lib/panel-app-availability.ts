/**
 * Whether an app that opens from the Apps panel is listed there switched
 * off, as needing a server update.
 *
 * It is whenever the server has answered and does not offer the app to a
 * person who would otherwise find it in the panel. Why the server does not
 * offer it makes no difference to them: it may predate such apps, have them
 * turned off, or run them without this one. Nothing is said while the
 * server may still answer.
 */
export const panelAppNeedsServerUpdate = ({
  runtime,
  offered,
  isJoined,
  isWebinarAttendee,
}: {
  /** What the server said of authority apps: `useAuthorityRuntime()`. */
  runtime: "unknown" | "unsupported" | "ready";
  /** Whether it offers this app to this connection. */
  offered: boolean;
  isJoined: boolean;
  isWebinarAttendee: boolean;
}): boolean =>
  isJoined && !isWebinarAttendee && runtime !== "unknown" && !offered;
