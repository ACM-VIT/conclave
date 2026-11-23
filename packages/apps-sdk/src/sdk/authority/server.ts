/**
 * The server side of an authority app: its rules, tables, views and timers.
 * React-free, and loaded only by the SFU. `check:apps` fails any web or
 * native file that imports this or an app's `server` entry.
 */
export * from "#authority/schema";
export * from "#authority/contract";
export * from "#authority/definition";
