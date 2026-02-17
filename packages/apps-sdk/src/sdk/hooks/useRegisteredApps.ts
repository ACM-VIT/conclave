import { useMemo } from "react";
import type { AppPlatform, ConclaveApp } from "../types/index";
import { useApps } from "./useApps";

export type RegisteredApp = ConclaveApp & {
  isActive: boolean;
  supportsWeb: boolean;
  supportsNative: boolean;
};

const isAppSupportedOnPlatform = (app: ConclaveApp, platform?: AppPlatform): boolean => {
  if (!platform) return true;
  if (platform === "web") return Boolean(app.web);
  return Boolean(app.native);
};

export const useRegisteredApps = (platform?: AppPlatform): RegisteredApp[] => {
  const { state, apps } = useApps();

  return useMemo(() => {
    return apps
      .filter((app) => isAppSupportedOnPlatform(app, platform))
      .map((app) => ({
        ...app,
        isActive: state.activeAppId === app.id,
        supportsWeb: Boolean(app.web),
        supportsNative: Boolean(app.native),
      }));
  }, [apps, platform, state.activeAppId]);
};
