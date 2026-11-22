import { useMemo } from "react";
import { useApps } from "./useApps";

export const useAppDoc = (appId: string) => {
  const { getDoc, getAwareness, state } = useApps();
  const doc = useMemo(() => getDoc(appId), [appId, getDoc]);
  const awareness = useMemo(() => getAwareness(appId), [appId, getAwareness]);
  return {
    doc,
    awareness,
    isActive: state.activeAppId === appId,
    locked: state.locked,
  };
};
