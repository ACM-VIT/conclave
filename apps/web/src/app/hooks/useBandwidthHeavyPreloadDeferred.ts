"use client";

import { useEffect, useState } from "react";
import {
  getBrowserNetworkInformation,
  shouldDeferBandwidthHeavyPreload,
} from "../lib/network-information";

const useNetworkBoolean = (readValue: () => boolean): boolean => {
  const [value, setValue] = useState(readValue);

  useEffect(() => {
    const update = () => setValue(readValue());
    const connection = getBrowserNetworkInformation();

    update();
    connection?.addEventListener?.("change", update);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);

    return () => {
      connection?.removeEventListener?.("change", update);
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [readValue]);

  return value;
};

export function useBandwidthHeavyPreloadDeferred(): boolean {
  return useNetworkBoolean(shouldDeferBandwidthHeavyPreload);
}
