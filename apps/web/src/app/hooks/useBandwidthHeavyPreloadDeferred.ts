"use client";

import { useEffect, useState } from "react";
import {
  getBrowserNetworkInformation,
  shouldDeferBandwidthHeavyPreload,
} from "../lib/network-information";

export function useBandwidthHeavyPreloadDeferred(): boolean {
  const [deferred, setDeferred] = useState(() =>
    shouldDeferBandwidthHeavyPreload(),
  );

  useEffect(() => {
    const update = () => setDeferred(shouldDeferBandwidthHeavyPreload());
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
  }, []);

  return deferred;
}
