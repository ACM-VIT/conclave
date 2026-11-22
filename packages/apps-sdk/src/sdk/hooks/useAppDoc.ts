import { useMemo } from "react";
import { useApps } from "./useApps";

export const useAppDoc = (appId: string) => {
  const { getDoc, getAwareness, state, docsVersion } = useApps();
  const doc = useMemo(() => getDoc(appId), [appId, getDoc, docsVersion]);
  const awareness = useMemo(() => getAwareness(appId), [appId, getAwareness, docsVersion]);
  return {
    doc,
    awareness,
    isActive: state.activeAppId === appId,
    locked: state.locked,
  };
};
