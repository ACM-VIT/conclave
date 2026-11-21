import type { AuthorityModule } from "@conclave/apps-sdk/authority/server";

/**
 * The authority apps this SFU runs: reviewed modules from this repository,
 * imported by name. A module is trusted server code, so nothing a room, a
 * client or a URL names is ever loaded. To add an app, import its `server`
 * entry here.
 */
export const AUTHORITY_MODULES: readonly AuthorityModule[] = [];

export const assertUniqueModules = (
  modules: readonly AuthorityModule[],
): readonly AuthorityModule[] => {
  const seen = new Set<string>();
  for (const module of modules) {
    if (seen.has(module.contract.id)) {
      throw new Error(`Authority app "${module.contract.id}" is registered twice`);
    }
    seen.add(module.contract.id);
  }
  return modules;
};
