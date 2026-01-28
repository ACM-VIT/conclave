export const reactionAssetList = [
  "aura.gif",
  "crycry.gif",
  "goblin.gif",
  "phone.gif",
  "sixseven.gif",
  "yawn.gif",
] as const;

export const reactionAssetMap: Record<string, number> = {
  "aura.gif": require("../../../assets/reactions/aura.gif"),
  "crycry.gif": require("../../../assets/reactions/crycry.gif"),
  "goblin.gif": require("../../../assets/reactions/goblin.gif"),
  "phone.gif": require("../../../assets/reactions/phone.gif"),
  "sixseven.gif": require("../../../assets/reactions/sixseven.gif"),
  "yawn.gif": require("../../../assets/reactions/yawn.gif"),
};
