import { useMemo } from "react";
import { useApps } from "./useApps";

export const useAppDoc = (appId: string) => {
  const { getDoc, getAwareness, state } = useApps();
  // The provider replaces its local copy whenever the presented app or its
  // document changes, so read the live one again on either.
  const { activeAppId, docGeneration } = state;
  const doc = useMemo(
    () => getDoc(appId),
    [appId, getDoc, activeAppId, docGeneration],
  );
  const awareness = useMemo(
    () => getAwareness(appId),
    [appId, getAwareness, activeAppId, docGeneration],
  );
  return {
    doc,
    awareness,
    isActive: activeAppId === appId,
    locked: state.locked,
  };
};
