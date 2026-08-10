import { ContainerManager } from "./ContainerManager.js";
import { KitesurfManager } from "./KitesurfManager.js";
import { defaultConfig, type BrowserManager, type BrowserServiceConfig } from "./types.js";

export const createBrowserManager = (
    config: BrowserServiceConfig = defaultConfig,
): BrowserManager =>
    config.provider === "kitesurf"
        ? new KitesurfManager(config)
        : new ContainerManager(config);
