/**
 * Which app ids are free. An app's id is its folder under `src/apps` and the
 * first part of its package subpaths (`@conclave/apps-sdk/<id>/core`), so an
 * id the SDK already uses there would replace a piece of the SDK itself.
 */

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

/** Why a new app cannot have this id, or null when it can. */
export const appIdProblem = (appId, exports) => {
  if (!/^[a-z]/.test(appId)) {
    return `App id "${appId}" must start with a letter.`;
  }
  if (RESERVED_APP_IDS.has(appId)) {
    return `"${appId}" is a name the SDK keeps for itself. Choose another app id.`;
  }
  const taken = exportsUnder(exports, appId);
  if (taken.length > 0) {
    return `"${appId}" is taken: package.json already exports ${taken.join(", ")}. Choose another app id.`;
  }
  return null;
};
