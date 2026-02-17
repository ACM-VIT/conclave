import { useApps } from "./useApps";

export const useAppAssets = () => {
  const { uploadAsset } = useApps();
  if (!uploadAsset) {
    return {
      uploadAsset: async () => {
        throw new Error("Asset uploads are not configured.");
      },
    };
  }
  return { uploadAsset };
};
