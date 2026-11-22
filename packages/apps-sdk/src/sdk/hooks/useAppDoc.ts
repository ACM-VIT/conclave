import { useMemo } from "react";
import { useApps } from "./useApps";

export const useAppDoc = (appId: string) => {
  const { documents, state } = useApps();
  const doc = useMemo(() => documents.doc(appId), [appId, documents]);
  const awareness = useMemo(() => documents.awareness(appId), [appId, documents]);
  return {
    doc,
    awareness,
    isActive: state.activeAppId === appId,
    locked: state.locked,
  };
};
