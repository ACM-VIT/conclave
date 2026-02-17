import type { ConclaveApp } from "../types/index";

const registry = new Map<string, ConclaveApp>();
const listeners = new Set<() => void>();

const emitRegistryChange = () => {
  for (const listener of listeners) {
    listener();
  }
};

const validateApp = (app: ConclaveApp): void => {
  if (!app?.id || app.id.trim().length === 0) {
    throw new Error("App id is required");
  }
  if (!app.name || app.name.trim().length === 0) {
    throw new Error(`App ${app.id}: name is required`);
  }
  if (!app.web && !app.native) {
    throw new Error(`App ${app.id}: at least one renderer (web/native) is required`);
  }
};

export const defineApp = <T extends ConclaveApp>(app: T): T => {
  validateApp(app);
  return app;
};

export const registerApp = (app: ConclaveApp): boolean => {
  validateApp(app);
  const existing = registry.get(app.id);
  if (existing === app) {
    return false;
  }
  registry.set(app.id, app);
  emitRegistryChange();
  return true;
};

export const registerApps = (apps: Iterable<ConclaveApp>): number => {
  let changed = 0;
  for (const app of apps) {
    if (registerApp(app)) {
      changed += 1;
    }
  }
  return changed;
};

export const getRegisteredApps = (): ConclaveApp[] => {
  return Array.from(registry.values());
};

export const getAppById = (appId: string): ConclaveApp | undefined => {
  return registry.get(appId);
};

export const clearRegisteredApps = (): void => {
  if (registry.size === 0) return;
  registry.clear();
  emitRegistryChange();
};

export const subscribeRegistry = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
