/**
 * Which app ids are free. An app's id is its folder under `src/apps` and the
 * first part of its package subpaths (`@conclave/apps-sdk/<id>/core`), so an
 * id the SDK already uses there would replace a piece of the SDK itself.
 */
import { appIdProblem } from "../src/sdk/authority/contract.ts";

/** Names the SDK keeps for its own entry points, folders and app parts. */
export const RESERVED_APP_IDS = new Set([
  "authority",
  "native-embed",
  "sdk",
  "apps",
  "core",
  "web",
  "server",
  "native",
]);

/** What `package.json` already exports at `./<appId>` or below it. */
export const exportsUnder = (exports, appId) =>
  Object.keys(exports ?? {}).filter(
    (key) => key === `./${appId}` || key.startsWith(`./${appId}/`),
  );

/**
 * Why no app folder may have this name, or null when one may. What an id
 * looks like is the SDK's own rule, the one `defineContract` enforces, read
 * from the SDK's source so the tools cannot come to disagree with it.
 */
export const appFolderProblem = (appId) => {
  const problem = appIdProblem(appId);
  if (problem) return `is not a valid app id: ${problem}`;
  if (RESERVED_APP_IDS.has(appId)) return "is a name the SDK keeps for itself";
  return null;
};

/** Why a new app cannot have this id, or null when it can. */
export const newAppIdProblem = (appId, exports) => {
  const problem = appFolderProblem(appId);
  if (problem) return `"${appId}" ${problem}. Choose another app id.`;
  const taken = exportsUnder(exports, appId);
  if (taken.length > 0) {
    return `"${appId}" is taken: package.json already exports ${taken.join(", ")}. Choose another app id.`;
  }
  return null;
};
