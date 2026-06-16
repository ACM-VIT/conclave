"use client";

import type { LucideIcon } from "lucide-react";
import {
  Armchair,
  Blend,
  Building2,
  Coffee,
  Crown,
  Flower2,
  Focus,
  Glasses,
  HatGlasses,
  ImagePlus,
  LampDesk,
  Layers,
  Leaf,
  Lightbulb,
  LibraryBig,
  Palette,
  Plane,
  Rabbit,
  Rocket,
  Snowflake,
  Sparkles,
  Sofa,
  SunMedium,
  VenetianMask,
  WandSparkles,
  Waves,
} from "lucide-react";

export type BackgroundEffectId =
  | "none"
  | "blur-light"
  | "blur-strong"
  | "desk-motion"
  | "loft-motion"
  | "aurora-motion"
  | "office"
  | "lounge"
  | "beach"
  | "forest"
  | "studio"
  | "bookshelf"
  | "coffee-shop"
  | "home-office-bookshelf"
  | "home-office-living-room"
  | "home-office-sofa"
  | "living-room-close"
  | "living-room-shelf"
  | "living-room-wide"
  | "modern-conference-room"
  | "modern-indian-living-room"
  | "office-break-room"
  | "office-library"
  | "office-meeting-space"
  | "office-green-space"
  | "shelf-with-plants"
  | "stylish-home-office"
  | "stylish-living-room-couch"
  | "cyberpunk-penthouse"
  | "tropical-beach"
  | "accessible-patio"
  | "gaming-room"
  | "rainy-conservatory"
  | "rainy-cafe"
  | "sunny-cafe"
  | "rustic-cabin"
  | "snowy-chalet"
  | "underwater-sea-lab"
  | "space-station"
  | "japanese-courtyard"
  | "parisian-skyline"
  | "greenhouse"
  | "italian-terrace-countryside"
  | "physics-lab"
  | "lakeside-tent"
  | "gradient"
  | "custom";

export type FaceFilterId =
  | "none"
  | "glasses"
  | "crown"
  | "halo"
  | "idea"
  | "mustache"
  | "thin-mustache"
  | "sparkles"
  | "aviator"
  | "cat-eye-beret"
  | "cute-glasses"
  | "cyber-glasses"
  | "cat-ear-headphones"
  | "cat-ears-glasses"
  | "cat-on-head"
  | "fuzzy-cat"
  | "halloween-cat"
  | "velvety-dog"
  | "bunny"
  | "working-bunny"
  | "bunny-ears"
  | "beach-day"
  | "cute-astronaut"
  | "pirate"
  | "party-hat"
  | "pilot-hat"
  | "trucker-hat"
  | "winter-hat-scarf"
  | "wizard-hat"
  | "glowing-hat"
  | "noogler-hat"
  | "intern-hat"
  | "dia-de-los-muertos"
  | "dia-de-los-muertos-flower"
  | "butterflies"
  | "makeup-barely-there"
  | "makeup-simply-radiant"
  | "makeup-dewy-fresh"
  | "makeup-warm-glow"
  | "makeup-coral-hint"
  | "makeup-berry-blush"
  | "makeup-cat-eye"
  | "makeup-dramatic-eye"
  | "makeup-lip-gloss"
  | "makeup-pink-dewy"
  | "makeup-red-lipstick"
  | "makeup-rosy-pink"
  | "makeup-signature-statement"
  | "makeup-goth-chic"
  | "makeup-mummy"
  | "makeup-zombie"
  | "cute-alien"
  | "alien";

export type AppearanceStyleId =
  | "none"
  | "cloudy"
  | "ocean"
  | "mono"
  | "glow";

export interface VideoEffectsState {
  background: BackgroundEffectId;
  filter: FaceFilterId;
  style: AppearanceStyleId;
  studioLighting: boolean;
  studioLook: boolean;
  framing: boolean;
  customBackgroundId: string | null;
  customBackgroundDataUrl: string | null;
  customBackgroundName: string | null;
}

export interface VideoEffectOption<T extends string> {
  id: T;
  label: string;
  ariaLabel?: string;
  description?: string;
  icon: LucideIcon;
  tone: string;
  assetPath?: string;
  thumbnailPath?: string;
  motion?: boolean;
  category?: string;
}

export const DEFAULT_VIDEO_EFFECTS: VideoEffectsState = {
  background: "none",
  filter: "none",
  style: "none",
  studioLighting: false,
  studioLook: false,
  framing: false,
  customBackgroundId: null,
  customBackgroundDataUrl: null,
  customBackgroundName: null,
};

const BACKGROUND_EFFECT_IDS = new Set<BackgroundEffectId>([
  "none",
  "blur-light",
  "blur-strong",
  "desk-motion",
  "loft-motion",
  "aurora-motion",
  "office",
  "lounge",
  "beach",
  "forest",
  "studio",
  "bookshelf",
  "coffee-shop",
  "home-office-bookshelf",
  "home-office-living-room",
  "home-office-sofa",
  "living-room-close",
  "living-room-shelf",
  "living-room-wide",
  "modern-conference-room",
  "modern-indian-living-room",
  "office-break-room",
  "office-library",
  "office-meeting-space",
  "office-green-space",
  "shelf-with-plants",
  "stylish-home-office",
  "stylish-living-room-couch",
  "cyberpunk-penthouse",
  "tropical-beach",
  "accessible-patio",
  "gaming-room",
  "rainy-conservatory",
  "rainy-cafe",
  "sunny-cafe",
  "rustic-cabin",
  "snowy-chalet",
  "underwater-sea-lab",
  "space-station",
  "japanese-courtyard",
  "parisian-skyline",
  "greenhouse",
  "italian-terrace-countryside",
  "physics-lab",
  "lakeside-tent",
  "gradient",
  "custom",
]);
export const ANIMATED_BACKGROUND_EFFECT_IDS = new Set<BackgroundEffectId>([
  "desk-motion",
  "loft-motion",
  "aurora-motion",
]);
const FACE_FILTER_IDS = new Set<FaceFilterId>([
  "none",
  "glasses",
  "crown",
  "halo",
  "idea",
  "mustache",
  "thin-mustache",
  "sparkles",
  "aviator",
  "cat-eye-beret",
  "cute-glasses",
  "cyber-glasses",
  "cat-ear-headphones",
  "cat-ears-glasses",
  "cat-on-head",
  "fuzzy-cat",
  "halloween-cat",
  "velvety-dog",
  "bunny",
  "working-bunny",
  "bunny-ears",
  "beach-day",
  "cute-astronaut",
  "pirate",
  "party-hat",
  "pilot-hat",
  "trucker-hat",
  "winter-hat-scarf",
  "wizard-hat",
  "glowing-hat",
  "noogler-hat",
  "intern-hat",
  "dia-de-los-muertos",
  "dia-de-los-muertos-flower",
  "butterflies",
  "makeup-barely-there",
  "makeup-simply-radiant",
  "makeup-dewy-fresh",
  "makeup-warm-glow",
  "makeup-coral-hint",
  "makeup-berry-blush",
  "makeup-cat-eye",
  "makeup-dramatic-eye",
  "makeup-lip-gloss",
  "makeup-pink-dewy",
  "makeup-red-lipstick",
  "makeup-rosy-pink",
  "makeup-signature-statement",
  "makeup-goth-chic",
  "makeup-mummy",
  "makeup-zombie",
  "cute-alien",
  "alien",
]);
const APPEARANCE_STYLE_IDS = new Set<AppearanceStyleId>([
  "none",
  "cloudy",
  "ocean",
  "mono",
  "glow",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isBackgroundEffectId = (value: unknown): value is BackgroundEffectId =>
  typeof value === "string" &&
  BACKGROUND_EFFECT_IDS.has(value as BackgroundEffectId);

export const isAnimatedBackgroundEffect = (
  value: BackgroundEffectId,
): boolean => ANIMATED_BACKGROUND_EFFECT_IDS.has(value);

const isFaceFilterId = (value: unknown): value is FaceFilterId =>
  typeof value === "string" && FACE_FILTER_IDS.has(value as FaceFilterId);

const isAppearanceStyleId = (value: unknown): value is AppearanceStyleId =>
  typeof value === "string" &&
  APPEARANCE_STYLE_IDS.has(value as AppearanceStyleId);

export const CUSTOM_BACKGROUND_MAX_DATA_URL_CHARS = 4_000_000;

const isCustomBackgroundId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^custom-[a-z0-9-]{8,80}$/i.test(value);

const isCustomBackgroundDataUrl = (value: unknown): value is string =>
  typeof value === "string" &&
  /^data:image\/(png|jpe?g|webp);base64,/i.test(value) &&
  value.length <= CUSTOM_BACKGROUND_MAX_DATA_URL_CHARS;

const normalizeCustomBackgroundName = (value: unknown) => {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, 80);
};

export function normalizeVideoEffectsState(value: unknown): VideoEffectsState {
  if (!isRecord(value)) return DEFAULT_VIDEO_EFFECTS;

  const customBackgroundDataUrl = isCustomBackgroundDataUrl(
    value.customBackgroundDataUrl,
  )
    ? value.customBackgroundDataUrl
    : null;
  const customBackgroundId = isCustomBackgroundId(value.customBackgroundId)
    ? value.customBackgroundId
    : null;
  const hasCustomBackground = Boolean(
    customBackgroundDataUrl || customBackgroundId,
  );
  const background =
    isBackgroundEffectId(value.background) &&
    (value.background !== "custom" || hasCustomBackground)
      ? value.background
      : DEFAULT_VIDEO_EFFECTS.background;

  return {
    background,
    filter: isFaceFilterId(value.filter)
      ? value.filter
      : DEFAULT_VIDEO_EFFECTS.filter,
    style: isAppearanceStyleId(value.style)
      ? value.style
      : DEFAULT_VIDEO_EFFECTS.style,
    studioLighting:
      typeof value.studioLighting === "boolean"
        ? value.studioLighting
        : DEFAULT_VIDEO_EFFECTS.studioLighting,
    studioLook:
      typeof value.studioLook === "boolean"
        ? value.studioLook
        : DEFAULT_VIDEO_EFFECTS.studioLook,
    framing:
      typeof value.framing === "boolean"
        ? value.framing
        : DEFAULT_VIDEO_EFFECTS.framing,
    customBackgroundId,
    customBackgroundDataUrl,
    customBackgroundName: hasCustomBackground
      ? normalizeCustomBackgroundName(value.customBackgroundName) ??
        "Uploaded image"
      : null,
  };
}

export function normalizeVideoEffectsStateForStorage(
  value: unknown,
): VideoEffectsState {
  const normalized = normalizeVideoEffectsState(value);
  return {
    ...normalized,
    customBackgroundDataUrl: normalized.customBackgroundId
      ? null
      : normalized.customBackgroundDataUrl,
  };
}

export const BACKGROUND_ASSET_PATHS = {
  office: "/effects/backgrounds/office-shelf.webp",
  lounge: "/effects/backgrounds/warm-lounge.webp",
  beach: "/effects/backgrounds/beach-pavilion.webp",
  forest: "/effects/backgrounds/forest-light.webp",
  studio: "/effects/backgrounds/conference-wall.webp",
  bookshelf: "/effects/backgrounds/bookshelf.webp",
  "coffee-shop": "/effects/backgrounds/coffee-shop.webp",
  "home-office-bookshelf": "/effects/backgrounds/home-office-bookshelf.webp",
  "home-office-living-room":
    "/effects/backgrounds/home-office-living-room.webp",
  "home-office-sofa": "/effects/backgrounds/home-office-sofa.webp",
  "living-room-close": "/effects/backgrounds/living-room-close.webp",
  "living-room-shelf": "/effects/backgrounds/living-room-shelf.webp",
  "living-room-wide": "/effects/backgrounds/living-room-wide.webp",
  "modern-conference-room":
    "/effects/backgrounds/modern-conference-room.webp",
  "modern-indian-living-room":
    "/effects/backgrounds/modern-indian-living-room.webp",
  "office-break-room": "/effects/backgrounds/office-break-room.webp",
  "office-library": "/effects/backgrounds/office-library.webp",
  "office-meeting-space": "/effects/backgrounds/office-meeting-space.webp",
  "office-green-space": "/effects/backgrounds/office-green-space.webp",
  "shelf-with-plants": "/effects/backgrounds/shelf-with-plants.webp",
  "stylish-home-office": "/effects/backgrounds/stylish-home-office.webp",
  "stylish-living-room-couch":
    "/effects/backgrounds/stylish-living-room-couch.webp",
  "cyberpunk-penthouse": "/effects/backgrounds/cyberpunk-penthouse.webp",
  "tropical-beach": "/effects/backgrounds/tropical-beach.webp",
  "accessible-patio": "/effects/backgrounds/accessible-patio.webp",
  "gaming-room": "/effects/backgrounds/gaming-room.webp",
  "rainy-conservatory": "/effects/backgrounds/rainy-conservatory.webp",
  "rainy-cafe": "/effects/backgrounds/rainy-cafe.webp",
  "sunny-cafe": "/effects/backgrounds/sunny-cafe.webp",
  "rustic-cabin": "/effects/backgrounds/rustic-cabin.webp",
  "snowy-chalet": "/effects/backgrounds/snowy-chalet.webp",
  "underwater-sea-lab": "/effects/backgrounds/underwater-sea-lab.webp",
  "space-station": "/effects/backgrounds/space-station.webp",
  "japanese-courtyard": "/effects/backgrounds/japanese-courtyard.webp",
  "parisian-skyline": "/effects/backgrounds/parisian-skyline.webp",
  greenhouse: "/effects/backgrounds/greenhouse.webp",
  "italian-terrace-countryside":
    "/effects/backgrounds/italian-terrace-countryside.webp",
  "physics-lab": "/effects/backgrounds/physics-lab.webp",
  "lakeside-tent": "/effects/backgrounds/lakeside-tent.webp",
} satisfies Partial<Record<BackgroundEffectId, string>>;

export const getVideoEffectPreviewPath = <T extends string>(
  option: VideoEffectOption<T>,
) => {
  if (option.thumbnailPath) return option.thumbnailPath;
  if (!option.assetPath) return null;
  if (option.assetPath.startsWith("/effects/backgrounds/")) {
    return option.assetPath.replace(
      "/effects/backgrounds/",
      "/effects/background-thumbnails/",
    );
  }
  return option.assetPath;
};

export const BACKGROUND_EFFECTS: VideoEffectOption<BackgroundEffectId>[] = [
  {
    id: "none",
    label: "No background",
    icon: Layers,
    tone: "#27272a",
    category: "Blur and personal",
  },
  {
    id: "blur-light",
    label: "Slight blur",
    ariaLabel: "Slightly blur your background",
    icon: Blend,
    tone: "#155e75",
    category: "Blur and personal",
  },
  {
    id: "blur-strong",
    label: "Blur",
    ariaLabel: "Blur your background",
    icon: Blend,
    tone: "#1d4ed8",
    category: "Blur and personal",
  },
  {
    id: "desk-motion",
    label: "Desk motion",
    icon: LampDesk,
    tone: "#1e3a8a",
    motion: true,
    category: "Immersive",
  },
  {
    id: "loft-motion",
    label: "Loft motion",
    icon: Building2,
    tone: "#7c2d12",
    motion: true,
    category: "Immersive",
  },
  {
    id: "aurora-motion",
    label: "Aurora motion",
    icon: Waves,
    tone: "#155e75",
    motion: true,
    category: "Immersive",
  },
  {
    id: "cyberpunk-penthouse",
    label: "Cyberpunk penthouse",
    icon: Building2,
    tone: "#7c3aed",
    assetPath: BACKGROUND_ASSET_PATHS["cyberpunk-penthouse"],
    category: "Immersive",
  },
  {
    id: "gaming-room",
    label: "Gaming room",
    icon: ImagePlus,
    tone: "#4f46e5",
    assetPath: BACKGROUND_ASSET_PATHS["gaming-room"],
    category: "Immersive",
  },
  {
    id: "rainy-conservatory",
    label: "Rainy conservatory",
    icon: Leaf,
    tone: "#0f766e",
    assetPath: BACKGROUND_ASSET_PATHS["rainy-conservatory"],
    category: "Immersive",
  },
  {
    id: "rainy-cafe",
    label: "Rainy cafe",
    icon: Coffee,
    tone: "#78350f",
    assetPath: BACKGROUND_ASSET_PATHS["rainy-cafe"],
    category: "Immersive",
  },
  {
    id: "sunny-cafe",
    label: "Sunny cafe",
    icon: SunMedium,
    tone: "#ca8a04",
    assetPath: BACKGROUND_ASSET_PATHS["sunny-cafe"],
    category: "Immersive",
  },
  {
    id: "rustic-cabin",
    label: "Rustic cabin",
    icon: Armchair,
    tone: "#854d0e",
    assetPath: BACKGROUND_ASSET_PATHS["rustic-cabin"],
    category: "Immersive",
  },
  {
    id: "snowy-chalet",
    label: "Snowy chalet",
    icon: Snowflake,
    tone: "#0369a1",
    assetPath: BACKGROUND_ASSET_PATHS["snowy-chalet"],
    category: "Immersive",
  },
  {
    id: "underwater-sea-lab",
    label: "Underwater sea lab",
    icon: Waves,
    tone: "#0e7490",
    assetPath: BACKGROUND_ASSET_PATHS["underwater-sea-lab"],
    category: "Immersive",
  },
  {
    id: "space-station",
    label: "Space station",
    icon: Rocket,
    tone: "#334155",
    assetPath: BACKGROUND_ASSET_PATHS["space-station"],
    category: "Immersive",
  },
  {
    id: "japanese-courtyard",
    label: "Japanese courtyard",
    icon: Leaf,
    tone: "#166534",
    assetPath: BACKGROUND_ASSET_PATHS["japanese-courtyard"],
    category: "Immersive",
  },
  {
    id: "parisian-skyline",
    label: "Parisian skyline",
    icon: Building2,
    tone: "#475569",
    assetPath: BACKGROUND_ASSET_PATHS["parisian-skyline"],
    category: "Immersive",
  },
  {
    id: "greenhouse",
    label: "Greenhouse",
    icon: Leaf,
    tone: "#15803d",
    assetPath: BACKGROUND_ASSET_PATHS.greenhouse,
    category: "Immersive",
  },
  {
    id: "italian-terrace-countryside",
    label: "Italian terrace",
    icon: SunMedium,
    tone: "#a16207",
    assetPath: BACKGROUND_ASSET_PATHS["italian-terrace-countryside"],
    category: "Immersive",
  },
  {
    id: "physics-lab",
    label: "Physics lab",
    icon: Lightbulb,
    tone: "#334155",
    assetPath: BACKGROUND_ASSET_PATHS["physics-lab"],
    category: "Immersive",
  },
  {
    id: "lakeside-tent",
    label: "Lakeside tent",
    icon: Waves,
    tone: "#0f766e",
    assetPath: BACKGROUND_ASSET_PATHS["lakeside-tent"],
    category: "Immersive",
  },
  {
    id: "office",
    label: "Office shelf",
    icon: ImagePlus,
    tone: "#52525b",
    assetPath: BACKGROUND_ASSET_PATHS.office,
    category: "Professional",
  },
  {
    id: "studio",
    label: "Conference wall",
    icon: ImagePlus,
    tone: "#475569",
    assetPath: BACKGROUND_ASSET_PATHS.studio,
    category: "Professional",
  },
  {
    id: "modern-conference-room",
    label: "Modern conference room",
    icon: Building2,
    tone: "#334155",
    assetPath: BACKGROUND_ASSET_PATHS["modern-conference-room"],
    category: "Professional",
  },
  {
    id: "office-break-room",
    label: "Office break room",
    icon: Coffee,
    tone: "#0f766e",
    assetPath: BACKGROUND_ASSET_PATHS["office-break-room"],
    category: "Professional",
  },
  {
    id: "office-library",
    label: "Office library",
    icon: LibraryBig,
    tone: "#365314",
    assetPath: BACKGROUND_ASSET_PATHS["office-library"],
    category: "Professional",
  },
  {
    id: "office-meeting-space",
    label: "Office meeting space",
    icon: Building2,
    tone: "#0f766e",
    assetPath: BACKGROUND_ASSET_PATHS["office-meeting-space"],
    category: "Professional",
  },
  {
    id: "office-green-space",
    label: "Office green space",
    icon: Leaf,
    tone: "#15803d",
    assetPath: BACKGROUND_ASSET_PATHS["office-green-space"],
    category: "Professional",
  },
  {
    id: "bookshelf",
    label: "Bookshelf",
    icon: LibraryBig,
    tone: "#713f12",
    assetPath: BACKGROUND_ASSET_PATHS.bookshelf,
    category: "Home office",
  },
  {
    id: "home-office-bookshelf",
    label: "Home office",
    icon: LampDesk,
    tone: "#854d0e",
    assetPath: BACKGROUND_ASSET_PATHS["home-office-bookshelf"],
    category: "Home office",
  },
  {
    id: "home-office-living-room",
    label: "Home office living room",
    icon: LampDesk,
    tone: "#57534e",
    assetPath: BACKGROUND_ASSET_PATHS["home-office-living-room"],
    category: "Home office",
  },
  {
    id: "shelf-with-plants",
    label: "Shelf with plants",
    icon: Leaf,
    tone: "#166534",
    assetPath: BACKGROUND_ASSET_PATHS["shelf-with-plants"],
    category: "Home office",
  },
  {
    id: "stylish-home-office",
    label: "Stylish home office",
    icon: LampDesk,
    tone: "#57534e",
    assetPath: BACKGROUND_ASSET_PATHS["stylish-home-office"],
    category: "Home office",
  },
  {
    id: "lounge",
    label: "Warm lounge",
    icon: ImagePlus,
    tone: "#7c2d12",
    assetPath: BACKGROUND_ASSET_PATHS.lounge,
    category: "Cozy home",
  },
  {
    id: "home-office-sofa",
    label: "Home sofa",
    icon: Sofa,
    tone: "#9a3412",
    assetPath: BACKGROUND_ASSET_PATHS["home-office-sofa"],
    category: "Cozy home",
  },
  {
    id: "living-room-close",
    label: "Living room close",
    icon: Sofa,
    tone: "#9a3412",
    assetPath: BACKGROUND_ASSET_PATHS["living-room-close"],
    category: "Cozy home",
  },
  {
    id: "living-room-shelf",
    label: "Living room shelf",
    icon: Armchair,
    tone: "#92400e",
    assetPath: BACKGROUND_ASSET_PATHS["living-room-shelf"],
    category: "Cozy home",
  },
  {
    id: "living-room-wide",
    label: "Living room wide",
    icon: Armchair,
    tone: "#475569",
    assetPath: BACKGROUND_ASSET_PATHS["living-room-wide"],
    category: "Cozy home",
  },
  {
    id: "modern-indian-living-room",
    label: "Modern Indian living room",
    icon: Armchair,
    tone: "#92400e",
    assetPath: BACKGROUND_ASSET_PATHS["modern-indian-living-room"],
    category: "Cozy home",
  },
  {
    id: "stylish-living-room-couch",
    label: "Stylish living room",
    icon: Sofa,
    tone: "#7f1d1d",
    assetPath: BACKGROUND_ASSET_PATHS["stylish-living-room-couch"],
    category: "Cozy home",
  },
  {
    id: "coffee-shop",
    label: "Coffee shop",
    icon: Coffee,
    tone: "#78350f",
    assetPath: BACKGROUND_ASSET_PATHS["coffee-shop"],
    category: "Social",
  },
  {
    id: "beach",
    label: "Beach pavilion",
    icon: ImagePlus,
    tone: "#0e7490",
    assetPath: BACKGROUND_ASSET_PATHS.beach,
    category: "Nature",
  },
  {
    id: "tropical-beach",
    label: "Tropical beach",
    icon: Waves,
    tone: "#0e7490",
    assetPath: BACKGROUND_ASSET_PATHS["tropical-beach"],
    category: "Nature",
  },
  {
    id: "forest",
    label: "Forest light",
    icon: ImagePlus,
    tone: "#166534",
    assetPath: BACKGROUND_ASSET_PATHS.forest,
    category: "Nature",
  },
  {
    id: "accessible-patio",
    label: "Accessible patio",
    icon: Leaf,
    tone: "#15803d",
    assetPath: BACKGROUND_ASSET_PATHS["accessible-patio"],
    category: "Nature",
  },
  {
    id: "gradient",
    label: "Color field",
    icon: Palette,
    tone: "#6d28d9",
    category: "Stylized",
  },
  {
    id: "custom",
    label: "Uploaded image",
    icon: ImagePlus,
    tone: "#F95F4A",
    category: "Personal",
  },
];

export const FACE_FILTERS: VideoEffectOption<FaceFilterId>[] = [
  {
    id: "none",
    label: "No filter",
    icon: Layers,
    tone: "#27272a",
    category: "New",
  },
  {
    id: "sparkles",
    label: "Sparkles",
    icon: Sparkles,
    tone: "#7c3aed",
    category: "New",
  },
  {
    id: "butterflies",
    label: "Butterflies",
    icon: Flower2,
    tone: "#db2777",
    category: "New",
  },
  {
    id: "makeup-barely-there",
    label: "Barely there",
    icon: Palette,
    tone: "#f9a8d4",
    category: "Makeup",
  },
  {
    id: "makeup-simply-radiant",
    label: "Simply radiant",
    icon: Sparkles,
    tone: "#f472b6",
    category: "Makeup",
  },
  {
    id: "makeup-dewy-fresh",
    label: "Dewy fresh",
    icon: Sparkles,
    tone: "#fb7185",
    category: "Makeup",
  },
  {
    id: "makeup-warm-glow",
    label: "Warm glow",
    icon: SunMedium,
    tone: "#f97316",
    category: "Makeup",
  },
  {
    id: "makeup-coral-hint",
    label: "Coral hint",
    icon: Palette,
    tone: "#fb923c",
    category: "Makeup",
  },
  {
    id: "makeup-berry-blush",
    label: "Berry blush",
    icon: Palette,
    tone: "#be185d",
    category: "Makeup",
  },
  {
    id: "makeup-cat-eye",
    label: "Cat eye",
    icon: Focus,
    tone: "#111827",
    category: "Makeup",
  },
  {
    id: "makeup-dramatic-eye",
    label: "Dramatic eye",
    icon: Focus,
    tone: "#312e81",
    category: "Makeup",
  },
  {
    id: "makeup-lip-gloss",
    label: "Lip gloss",
    icon: Palette,
    tone: "#f43f5e",
    category: "Makeup",
  },
  {
    id: "makeup-pink-dewy",
    label: "Pink dewy",
    icon: Palette,
    tone: "#ec4899",
    category: "Makeup",
  },
  {
    id: "makeup-red-lipstick",
    label: "Red lipstick",
    icon: Palette,
    tone: "#dc2626",
    category: "Makeup",
  },
  {
    id: "makeup-rosy-pink",
    label: "Rosy pink",
    icon: Palette,
    tone: "#f43f5e",
    category: "Makeup",
  },
  {
    id: "makeup-signature-statement",
    label: "Signature statement",
    icon: Sparkles,
    tone: "#a21caf",
    category: "Makeup",
  },
  {
    id: "makeup-goth-chic",
    label: "Goth chic",
    icon: VenetianMask,
    tone: "#171717",
    category: "Makeup",
  },
  {
    id: "makeup-mummy",
    label: "Mummy",
    icon: VenetianMask,
    tone: "#a8a29e",
    category: "Makeup",
  },
  {
    id: "makeup-zombie",
    label: "Zombie",
    icon: VenetianMask,
    tone: "#65a30d",
    category: "Makeup",
  },
  {
    id: "beach-day",
    label: "Beach day",
    icon: Waves,
    tone: "#0284c7",
    category: "New",
  },
  {
    id: "idea",
    label: "Idea bulb",
    description: "Open your mouth to light it.",
    icon: Lightbulb,
    tone: "#ca8a04",
    category: "Funny",
  },
  {
    id: "glasses",
    label: "Glasses",
    icon: Glasses,
    tone: "#0369a1",
    category: "Accessories",
  },
  {
    id: "cute-glasses",
    label: "Cute glasses",
    icon: Glasses,
    tone: "#ec4899",
    category: "Accessories",
  },
  {
    id: "aviator",
    label: "Aviator",
    icon: Plane,
    tone: "#334155",
    category: "Accessories",
  },
  {
    id: "cat-eye-beret",
    label: "Cat-eye beret",
    icon: VenetianMask,
    tone: "#be123c",
    category: "Accessories",
  },
  {
    id: "cyber-glasses",
    label: "Cyber glasses",
    icon: Glasses,
    tone: "#0891b2",
    category: "Accessories",
  },
  {
    id: "cat-ear-headphones",
    label: "Cat ear headphones",
    icon: HatGlasses,
    tone: "#7c3aed",
    category: "Accessories",
  },
  {
    id: "crown",
    label: "Gold crown",
    icon: Crown,
    tone: "#b45309",
    category: "Accessories",
  },
  {
    id: "halo",
    label: "Light halo",
    icon: SunMedium,
    tone: "#f59e0b",
    category: "Accessories",
  },
  {
    id: "bunny-ears",
    label: "Bunny ears",
    icon: Rabbit,
    tone: "#f9a8d4",
    category: "Costumes",
  },
  {
    id: "bunny",
    label: "Bunny",
    icon: Rabbit,
    tone: "#f472b6",
    category: "Costumes",
  },
  {
    id: "working-bunny",
    label: "Working bunny",
    icon: Rabbit,
    tone: "#2563eb",
    category: "Costumes",
  },
  {
    id: "cute-alien",
    label: "Cute alien",
    icon: Rocket,
    tone: "#22c55e",
    category: "Costumes",
  },
  {
    id: "cat-ears-glasses",
    label: "Cat ears and glasses",
    icon: VenetianMask,
    tone: "#ec4899",
    category: "Costumes",
  },
  {
    id: "cat-on-head",
    label: "Cat on head",
    icon: VenetianMask,
    tone: "#f59e0b",
    category: "Costumes",
  },
  {
    id: "fuzzy-cat",
    label: "Fuzzy cat",
    icon: VenetianMask,
    tone: "#a855f7",
    category: "Costumes",
  },
  {
    id: "halloween-cat",
    label: "Halloween cat",
    icon: VenetianMask,
    tone: "#f97316",
    category: "Costumes",
  },
  {
    id: "velvety-dog",
    label: "Velvety dog",
    icon: VenetianMask,
    tone: "#a16207",
    category: "Costumes",
  },
  {
    id: "cute-astronaut",
    label: "Cute astronaut",
    icon: Rocket,
    tone: "#2563eb",
    category: "Costumes",
  },
  {
    id: "pirate",
    label: "Pirate",
    icon: HatGlasses,
    tone: "#111827",
    category: "Costumes",
  },
  {
    id: "party-hat",
    label: "Party hat",
    icon: Sparkles,
    tone: "#7c3aed",
    category: "Costumes",
  },
  {
    id: "pilot-hat",
    label: "Pilot hat",
    icon: Plane,
    tone: "#1f2937",
    category: "Costumes",
  },
  {
    id: "trucker-hat",
    label: "Trucker hat",
    icon: HatGlasses,
    tone: "#2563eb",
    category: "Costumes",
  },
  {
    id: "glowing-hat",
    label: "Glowing hat",
    icon: Sparkles,
    tone: "#eab308",
    category: "Costumes",
  },
  {
    id: "noogler-hat",
    label: "Noogler hat",
    icon: HatGlasses,
    tone: "#f97316",
    category: "Costumes",
  },
  {
    id: "intern-hat",
    label: "Intern hat",
    icon: HatGlasses,
    tone: "#475569",
    category: "Costumes",
  },
  {
    id: "winter-hat-scarf",
    label: "Winter hat and scarf",
    icon: Snowflake,
    tone: "#0ea5e9",
    category: "Costumes",
  },
  {
    id: "wizard-hat",
    label: "Wizard hat",
    icon: WandSparkles,
    tone: "#7c3aed",
    category: "Costumes",
  },
  {
    id: "dia-de-los-muertos",
    label: "Dia de los Muertos",
    icon: Crown,
    tone: "#c2410c",
    category: "Costumes",
  },
  {
    id: "dia-de-los-muertos-flower",
    label: "Dia de los Muertos flower",
    icon: Flower2,
    tone: "#db2777",
    category: "Costumes",
  },
  {
    id: "alien",
    label: "Alien ship",
    icon: Rocket,
    tone: "#22c55e",
    category: "Costumes",
  },
  {
    id: "mustache",
    label: "Mustache",
    icon: WandSparkles,
    tone: "#44403c",
    category: "Costumes",
  },
  {
    id: "thin-mustache",
    label: "Thin mustache",
    icon: VenetianMask,
    tone: "#292524",
    category: "Costumes",
  },
];

export const APPEARANCE_STYLES: VideoEffectOption<AppearanceStyleId>[] = [
  {
    id: "none",
    label: "No style",
    icon: Layers,
    tone: "#27272a",
  },
  {
    id: "cloudy",
    label: "Cloudy day",
    icon: SunMedium,
    tone: "#64748b",
  },
  {
    id: "ocean",
    label: "Ocean",
    icon: Palette,
    tone: "#0369a1",
  },
  {
    id: "mono",
    label: "Black and white",
    icon: Palette,
    tone: "#52525b",
  },
  {
    id: "glow",
    label: "Glowing edges",
    icon: Focus,
    tone: "#eab308",
  },
];

export function hasActiveVideoEffects(effects: VideoEffectsState): boolean {
  return (
    effects.background !== "none" ||
    effects.filter !== "none" ||
    effects.style !== "none" ||
    effects.studioLighting ||
    effects.studioLook ||
    effects.framing
  );
}

export function countActiveVideoEffects(effects: VideoEffectsState): number {
  let count = 0;
  if (effects.background !== "none") count += 1;
  if (effects.filter !== "none") count += 1;
  if (effects.style !== "none") count += 1;
  if (effects.studioLighting) count += 1;
  if (effects.studioLook) count += 1;
  if (effects.framing) count += 1;
  return count;
}
