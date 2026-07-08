import type { IconRegistry } from "./types";
import { audioIcons } from "./icons/audio";
import { videoIcons } from "./icons/video";
import { callIcons } from "./icons/call";
import { peopleIcons } from "./icons/people";
import { chatIcons } from "./icons/chat";
import { statusIcons } from "./icons/status";
import { navigationIcons } from "./icons/navigation";
import { timeIcons } from "./icons/time";
import { docsIcons } from "./icons/docs";
import { securityIcons } from "./icons/security";
import { creativeIcons } from "./icons/creative";
import { worldIcons } from "./icons/world";
import { funIcons } from "./icons/fun";
import { sceneIcons } from "./icons/scenes";

/**
 * The full icon → animation registry, assembled from the per-domain modules
 * under ./icons. To tune an icon, edit its entry in the relevant module.
 */
export const ICONS: IconRegistry = {
  ...audioIcons,
  ...videoIcons,
  ...callIcons,
  ...peopleIcons,
  ...chatIcons,
  ...statusIcons,
  ...navigationIcons,
  ...timeIcons,
  ...docsIcons,
  ...securityIcons,
  ...creativeIcons,
  ...worldIcons,
  ...funIcons,
  ...sceneIcons,
};
