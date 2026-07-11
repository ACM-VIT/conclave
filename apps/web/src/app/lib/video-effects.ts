"use client";

import type { LucideIcon } from "lucide-react";
import {
  Armchair,
  Blend,
  Building2,
  CakeSlice,
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
  Scissors,
  Snowflake,
  Sparkles,
  SunMedium,
  VenetianMask,
  WandSparkles,
  Waves,
} from "lucide-react";

export type BackgroundEffectId =
  | "none"
  | "blur-light"
  | "blur-strong"
  | "office"
  | "beach"
  | "forest"
  | "studio"
  | "bookshelf"
  | "coffee-shop"
  | "home-office-bookshelf"
  | "living-room-wide"
  | "modern-conference-room"
  | "modern-indian-living-room"
  | "office-library"
  | "office-green-space"
  | "shelf-with-plants"
  | "accessible-patio"
  | "camper-vacation"
  | "dog-office"
  | "indian-balcony"
  | "arabian-cafe-terrace"
  | "ocean-terrace"
  | "snowy-cafe"
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
  | "high-ponytail"
  | "graduation-cap"
  | "strawberry"
  | "santa-beard"
  | "dreidel"
  | "valentines-panda"
  | "spring"
  | "dragon"
  | "cowboy"
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
  | "hair-medium-beard"
  | "long-wavy-hair"
  | "rusty-robot"
  | "feathery-dinosaur"
  | "diwali-2023"
  | "film-noir"
  | "octopus-on-head"
  | "fried-eggs"
  | "fascinator"
  | "rainbow-wig"
  | "pride-heart"
  | "unicorn-headband"
  | "scifi-helmet"
  | "puffer-fish"
  | "sloth"
  | "owl"
  | "pig"
  | "safety-helmet"
  | "cozy-blanket"
  | "bunny"
  | "working-bunny"
  | "bunny-ears"
  | "beach-day"
  | "cute-astronaut"
  | "pirate"
  | "cake"
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
  | "glow"
  | "bloom"
  | "moonlight"
  | "sunlight";

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

export const MEET_VIDEOPIPE_RUNTIME_RELEASE = "929503300";

export const isMeetVideoPipeRuntimeEnabled = (): boolean =>
  process.env.NEXT_PUBLIC_CONCLAVE_ENABLE_MEET_VIDEOPIPE !== "0";

export type FaceFilterEffectRenderMode =
  | "face-makeup"
  | "face-prop"
  | "face-hair"
  | "face-costume"
  | "face-lighting";

export interface FaceFilterEffectGraph {
  meetGraphId: string;
  meetEffectIdNumber?: number;
  renderMode: FaceFilterEffectRenderMode;
  assetProfile:
    | "effect-js-wasm-xass"
    | "makeup-tflite"
    | "fun-makeup-tflite"
    | "lut";
  dependencies: readonly (
    | "face_detection"
    | "face_landmarks"
    | "face_pose"
    | "face_surface"
  )[];
  requiresFaceLandmarks: boolean;
  requiresSegmentation: boolean;
  requiresMeetVideoPipe?: boolean;
  bundleAssets?: readonly string[];
  thumbnailAsset?: string;
  modelIntervalMs: number;
  liveBundleVersion: "929503300";
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
  "office",
  "beach",
  "forest",
  "studio",
  "bookshelf",
  "coffee-shop",
  "home-office-bookshelf",
  "living-room-wide",
  "modern-conference-room",
  "modern-indian-living-room",
  "office-library",
  "office-green-space",
  "shelf-with-plants",
  "accessible-patio",
  "camper-vacation",
  "dog-office",
  "indian-balcony",
  "arabian-cafe-terrace",
  "ocean-terrace",
  "snowy-cafe",
  "custom",
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
  "high-ponytail",
  "graduation-cap",
  "strawberry",
  "santa-beard",
  "dreidel",
  "valentines-panda",
  "spring",
  "dragon",
  "cowboy",
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
  "hair-medium-beard",
  "long-wavy-hair",
  "rusty-robot",
  "feathery-dinosaur",
  "diwali-2023",
  "film-noir",
  "octopus-on-head",
  "fried-eggs",
  "fascinator",
  "rainbow-wig",
  "pride-heart",
  "unicorn-headband",
  "scifi-helmet",
  "puffer-fish",
  "sloth",
  "owl",
  "pig",
  "safety-helmet",
  "cozy-blanket",
  "bunny",
  "working-bunny",
  "bunny-ears",
  "beach-day",
  "cute-astronaut",
  "pirate",
  "cake",
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
  "bloom",
  "moonlight",
  "sunlight",
]);

const createFaceGraph = (
  meetGraphId: string,
  renderMode: FaceFilterEffectRenderMode,
  assetProfile: FaceFilterEffectGraph["assetProfile"] = "effect-js-wasm-xass",
  modelIntervalMs = 200,
  exactMeetPackage?: Pick<
    FaceFilterEffectGraph,
    | "bundleAssets"
    | "meetEffectIdNumber"
    | "requiresMeetVideoPipe"
    | "thumbnailAsset"
  >,
): FaceFilterEffectGraph => ({
  meetGraphId,
  meetEffectIdNumber: exactMeetPackage?.meetEffectIdNumber,
  renderMode,
  assetProfile,
  dependencies:
    renderMode === "face-makeup" || assetProfile.endsWith("tflite")
      ? ["face_detection", "face_landmarks", "face_surface"]
      : ["face_detection", "face_landmarks", "face_pose"],
  requiresFaceLandmarks: true,
  requiresSegmentation: false,
  requiresMeetVideoPipe: exactMeetPackage?.requiresMeetVideoPipe,
  bundleAssets: exactMeetPackage?.bundleAssets,
  thumbnailAsset: exactMeetPackage?.thumbnailAsset,
  modelIntervalMs,
  liveBundleVersion: "929503300",
});

const MEET_MAKEUP_SHARED_ASSETS = [
  "config_2020_07_15_dynamic.xass",
  "config_2022_09_14_static.xass",
  "facedetector-front.f16.tflite",
  "facemesh-ultralite.f16.tflite",
] as const;

const createMeetMakeupGraph = (
  meetGraphId: string,
  meetEffectIdNumber: number,
  modelAsset: string,
  thumbnailAsset: string,
  assetProfile: FaceFilterEffectGraph["assetProfile"] = "makeup-tflite",
) =>
  createFaceGraph(meetGraphId, "face-makeup", assetProfile, 200, {
    meetEffectIdNumber,
    requiresMeetVideoPipe: true,
    bundleAssets: [...MEET_MAKEUP_SHARED_ASSETS, modelAsset],
    thumbnailAsset,
  });

const createMeetFaceGraph = (
  meetGraphId: string,
  meetEffectIdNumber: number,
  renderMode: FaceFilterEffectRenderMode,
  thumbnailAsset: string,
  bundleAssets?: readonly string[],
) =>
  createFaceGraph(meetGraphId, renderMode, "effect-js-wasm-xass", 200, {
    meetEffectIdNumber,
    requiresMeetVideoPipe: true,
    bundleAssets,
    thumbnailAsset,
  });

export const FACE_FILTER_EFFECT_GRAPHS: Partial<
  Record<FaceFilterId, FaceFilterEffectGraph>
> = {
  butterflies: createFaceGraph(
    "butterflies_and_makeup",
    "face-makeup",
    "effect-js-wasm-xass",
    200,
    {
      meetEffectIdNumber: 565,
      requiresMeetVideoPipe: true,
      bundleAssets: [
        "butterflies_and_makeup_c4a1419ce57f13a3e906b0f694f8dcf3.zip",
        "butterflies_and_makeup_77af64d21673c2fb22d4b25a5d2753f4.wasm.data",
        "butterflies_and_makeup_b1245861fd65e20658a2597be8d2e577.metadata.jspb",
      ],
      thumbnailAsset: "butterflies_and_makeup_5a9c770599973fd5846d70cf4c6052b4.png",
    },
  ),
  "makeup-barely-there": createMeetMakeupGraph(
    "makeup_barely_there_v2",
    650,
    "barely_there_251027_run_1_epoch_59.tflite",
    "makeup_barely_there_v2_ea7e7074027e8ee185b0c102b304df52.png",
  ),
  "makeup-simply-radiant": createMeetMakeupGraph(
    "makeup_simply_radiant_v2",
    655,
    "simply_radiant_20251027_run_3_epoch_59.tflite",
    "makeup_simply_radiant_v2_df864f51edcd1bfc4a5b651d78209896.png",
  ),
  "makeup-dewy-fresh": createMeetMakeupGraph(
    "makeup_dewy_fresh_v2",
    653,
    "dewy_fresh_251027_run_2_epoch_59.tflite",
    "makeup_dewy_fresh_v2_c9d938ffc6389ea30244d1212a161129.png",
  ),
  "makeup-warm-glow": createMeetMakeupGraph(
    "makeup_warm_glow_v2",
    656,
    "warm_glow_251027_run_4_epoch_59.tflite",
    "makeup_warm_glow_v2_ac84b9949982ba83246ab80a8f1d885e.png",
  ),
  "makeup-coral-hint": createMeetMakeupGraph(
    "makeup_coral_hint_v2",
    652,
    "coral_hint_251027_run_1_epoch_59.tflite",
    "makeup_coral_hint_v2_7be78597c16adc923e7925866221084d.png",
  ),
  "makeup-berry-blush": createMeetMakeupGraph(
    "makeup_berry_blush_v2",
    651,
    "berry_blush_251027_run_1_epoch_59.tflite",
    "makeup_berry_blush_v2_a687bf1f45f0e2dd5fbe015135fb7f7f.png",
  ),
  "makeup-cat-eye": createFaceGraph(
    "makeup_cat_eye",
    "face-makeup",
    "makeup-tflite",
    200,
    {
      meetEffectIdNumber: 604,
      requiresMeetVideoPipe: true,
      bundleAssets: [
        ...MEET_MAKEUP_SHARED_ASSETS,
        "cat_eye_250721_run_41_epoch_299.tflite",
      ],
      thumbnailAsset: "makeup_cat_eye_6f650ac9e71829e856c4d684baf42f0c.png",
    },
  ),
  "makeup-dramatic-eye": createFaceGraph(
    "makeup_dramatic_eye",
    "face-makeup",
    "makeup-tflite",
    200,
    {
      meetEffectIdNumber: 629,
      requiresMeetVideoPipe: true,
      bundleAssets: [
        ...MEET_MAKEUP_SHARED_ASSETS,
        "dramatic_eye_250721_run_14_epoch_299.tflite",
      ],
      thumbnailAsset:
        "makeup_dramatic_eye_784873fb8896602f4dd1d41267ba30ed.png",
    },
  ),
  "makeup-lip-gloss": createFaceGraph(
    "makeup_lip_gloss",
    "face-makeup",
    "makeup-tflite",
    200,
    {
      meetEffectIdNumber: 628,
      requiresMeetVideoPipe: true,
      bundleAssets: [
        ...MEET_MAKEUP_SHARED_ASSETS,
        "lip_gloss_250721_run_32_epoch_299.tflite",
      ],
      thumbnailAsset: "makeup_lip_gloss_bc56f88d47ce9086598a24931708bc74.png",
    },
  ),
  "makeup-pink-dewy": createFaceGraph(
    "makeup_pink_dewy",
    "face-makeup",
    "makeup-tflite",
    200,
    {
      meetEffectIdNumber: 606,
      requiresMeetVideoPipe: true,
      bundleAssets: [
        ...MEET_MAKEUP_SHARED_ASSETS,
        "pink_dewy_250624_run_2_epoch_299.tflite",
      ],
      thumbnailAsset: "makeup_pink_dewy_f19a8a00bf6e150a5876614dfca7f2f6.png",
    },
  ),
  "makeup-red-lipstick": createFaceGraph(
    "makeup_red_lipstick",
    "face-makeup",
    "makeup-tflite",
    200,
    {
      meetEffectIdNumber: 593,
      requiresMeetVideoPipe: true,
      bundleAssets: [
        ...MEET_MAKEUP_SHARED_ASSETS,
        "red_lipstick_250721_run_43_epoch_299.tflite",
      ],
      thumbnailAsset:
        "makeup_red_lipstick_a8e7ed43161b83c5b1e95906d36ef7fa.png",
    },
  ),
  "makeup-rosy-pink": createFaceGraph(
    "makeup_rosy_pink",
    "face-makeup",
    "makeup-tflite",
    200,
    {
      meetEffectIdNumber: 627,
      requiresMeetVideoPipe: true,
      bundleAssets: [
        ...MEET_MAKEUP_SHARED_ASSETS,
        "rosy_pink_250721_run_16_epoch_299.tflite",
      ],
      thumbnailAsset: "makeup_rosy_pink_f97e69441dbe0e5711fb2c2294703189.png",
    },
  ),
  "makeup-signature-statement": createMeetMakeupGraph(
    "makeup_signature_statement_v2",
    654,
    "signature_statement_251027_run_1_epoch_59.tflite",
    "makeup_signature_statement_v2_0964dbe8faa432c9133c35dee0263394.png",
  ),
  "makeup-goth-chic": createMeetMakeupGraph(
    "fun_makeup_goth_chic",
    633,
    "goth_chic_250624_run_9_epoch_299.tflite",
    "fun_makeup_goth_chic_83d0335290fc9757fa930313b5a35c3f.png",
    "fun-makeup-tflite",
  ),
  "makeup-mummy": createMeetMakeupGraph(
    "fun_makeup_mummy",
    636,
    "mummy_v4s.tflite",
    "fun_makeup_mummy_e9874106a0845fb839d00c1e1252a26c.png",
    "fun-makeup-tflite",
  ),
  "makeup-zombie": createMeetMakeupGraph(
    "fun_makeup_zombie",
    635,
    "risen_zombie_v2s.tflite",
    "fun_makeup_zombie_0df67af1eb3d3c3c9cdbe3b86badd0da.png",
    "fun-makeup-tflite",
  ),
  "beach-day": createMeetFaceGraph(
    "beach_day_v2",
    445,
    "face-prop",
    "beach_day_v2_4288ff378ab723a6f289a2616184ae04.png",
  ),
  "high-ponytail": createMeetFaceGraph(
    "high_ponytail_icon",
    7,
    "face-hair",
    "high_ponytail_icon_82225c06f6983cc72ea337b1a8d85f67.png",
  ),
  "graduation-cap": createMeetFaceGraph(
    "graduation_cap_v2",
    66,
    "face-costume",
    "graduation_cap_v2_4a677f623a44e04d40f40ab393b48fe7.png",
  ),
  strawberry: createMeetFaceGraph(
    "strawberry_js_v2",
    332,
    "face-costume",
    "strawberry_js_v2_f73238b1d7a86197d30b921681e49df3.png",
  ),
  "santa-beard": createMeetFaceGraph(
    "santa_beard",
    371,
    "face-costume",
    "santa_beard_e93f924d975eddeba2b4b9a54d6c7e7f.png",
  ),
  dreidel: createMeetFaceGraph(
    "dreidel_js",
    372,
    "face-costume",
    "dreidel_js_c65da9c99635ba3b998a8eaeb6f87591.png",
  ),
  "valentines-panda": createMeetFaceGraph(
    "valentines_day_panda_v2",
    394,
    "face-costume",
    "valentines_day_panda_v2_452978af72189fe44f6ffd06fc1f3fb9.png",
  ),
  spring: createMeetFaceGraph(
    "spring_js_v2",
    410,
    "face-costume",
    "spring_js_v2_47fdab782b0e24277f3db9c59f430c59.png",
  ),
  idea: createMeetFaceGraph(
    "lightbulb_js_v2",
    358,
    "face-prop",
    "lightbulb_js_v2_2a6824762e5b71649f47d04eaa60afdf.png",
  ),
  dragon: createMeetFaceGraph(
    "dragon_v2",
    416,
    "face-costume",
    "dragon_v2_e48e290de91ae05f22cf01509e31f596.png",
  ),
  cowboy: createMeetFaceGraph(
    "cowboy_v2",
    419,
    "face-costume",
    "cowboy_v2_25f3b2e4df7e8fdc7d7d284ae72c8beb.png",
  ),
  aviator: createMeetFaceGraph(
    "aviator_glasses_and_mustache_v2",
    520,
    "face-prop",
    "aviator_glasses_and_mustache_v2_fd3b2895c2ea96665eb2df184cc8524d.png",
  ),
  "cute-glasses": createMeetFaceGraph(
    "cute_glasses_v2",
    414,
    "face-prop",
    "cute_glasses_v2_842930c9a58ed8bbc28c8cdb9480c2a7.png",
  ),
  "cat-eye-beret": createMeetFaceGraph(
    "beret_and_cat_eye_glasses_v2",
    564,
    "face-prop",
    "beret_and_cat_eye_glasses_v2_22a4822de24dc7049e1ee78d7aaeddc8.png",
  ),
  "cyber-glasses": createMeetFaceGraph(
    "cyber_glasses_v2",
    550,
    "face-prop",
    "cyber_glasses_v2_035f21f48f1676f9b890ca54d9470363.png",
  ),
  "cat-ear-headphones": createMeetFaceGraph(
    "cat_ear_headphones",
    552,
    "face-prop",
    "cat_ear_headphones_1ac9a811cf18abc4a04cad39e8de6192.png",
  ),
  crown: createMeetFaceGraph(
    "crown",
    619,
    "face-prop",
    "crown_72bd8bd065f88579c5546ac48c3b837a.png",
  ),
  "bunny-ears": createMeetFaceGraph(
    "bunny_ears_v2",
    532,
    "face-costume",
    "bunny_ears_v2_2ba936a45e47edd1530cd0c5d7e7507d.png",
  ),
  bunny: createMeetFaceGraph(
    "bunny_v2",
    504,
    "face-costume",
    "bunny_v2_228a8ce2df8c9f18fcaaa731f4ca9437.png",
  ),
  "working-bunny": createMeetFaceGraph(
    "working_bunny_js_v2",
    322,
    "face-costume",
    "working_bunny_js_v2_6a4cb09051b7e8793597fa8530b16533.png",
  ),
  "cute-alien": createMeetFaceGraph(
    "cute_alien",
    588,
    "face-costume",
    "cute_alien_150945fb2cae3359b98d8c35d841c019.png",
  ),
  "cat-on-head": createMeetFaceGraph(
    "cat_on_head_js_v2",
    359,
    "face-costume",
    "cat_on_head_js_v2_e940a4b1ef134c37d9074423bf3e26c4.png",
  ),
  "cat-ears-glasses": createMeetFaceGraph(
    "cat_ears_and_glasses",
    560,
    "face-costume",
    "cat_ears_and_glasses_33fb90ca39d651cc6a87b927db5c2b6d.png",
  ),
  "fuzzy-cat": createMeetFaceGraph(
    "fuzzy_cat_v2",
    429,
    "face-costume",
    "fuzzy_cat_v2_ce73d089c60bd99c98bb63368b2054e4.png",
  ),
  "halloween-cat": createMeetFaceGraph(
    "halloween_cat_v2",
    360,
    "face-costume",
    "halloween_cat_v2_18a216608b581c9a108d18ad5d9084c9.png",
  ),
  "velvety-dog": createMeetFaceGraph(
    "velvety_dog_v2",
    446,
    "face-costume",
    "velvety_dog_v2_92fc3ce424d05ba7d2f9b7fd78269dff.png",
  ),
  "hair-medium-beard": createMeetFaceGraph(
    "hair_medium_beard",
    658,
    "face-hair",
    "hair_medium_beard_c849f407efaa95e342c711c6de72ffb6.png",
  ),
  "long-wavy-hair": createMeetFaceGraph(
    "long_wavy_hair",
    693,
    "face-hair",
    "long_wavy_hair_14e0e61bf57ccd06fe641a48357ad085.png",
  ),
  "rusty-robot": createMeetFaceGraph(
    "rusty_robot_v2",
    511,
    "face-costume",
    "rusty_robot_v2_c5461e2f4eeff5eac43f1b2d5cc9a034.png",
  ),
  "feathery-dinosaur": createMeetFaceGraph(
    "feathery_dinousaur_v2",
    484,
    "face-costume",
    "feathery_dinousaur_v2_e6e4ce401183a17e1b66c75b530b6f3f.png",
  ),
  "diwali-2023": createMeetFaceGraph(
    "diwali_2023",
    488,
    "face-costume",
    "diwali_2023_a0edba9497f8a246b2f61da5b20f8f20.png",
  ),
  "film-noir": createMeetFaceGraph(
    "film_noir_v2",
    505,
    "face-lighting",
    "film_noir_v2_343e63dc224c2eedcc7b8664ded7c434.png",
  ),
  "octopus-on-head": createMeetFaceGraph(
    "octopus_on_head_v2",
    523,
    "face-costume",
    "octopus_on_head_v2_f9fbfddfe86bbf52fa6ce3582238b6c8.png",
  ),
  "fried-eggs": createMeetFaceGraph(
    "fried_eggs_v2",
    533,
    "face-costume",
    "fried_eggs_v2_90399085e1cebc5e07c1ec7856da1a97.png",
  ),
  fascinator: createMeetFaceGraph(
    "fascinator_v2",
    536,
    "face-costume",
    "fascinator_v2_9eea468dfbda1ac4972b038fb9321736.png",
  ),
  "rainbow-wig": createMeetFaceGraph(
    "rainbow_wig_and_eyelashes_v2",
    539,
    "face-costume",
    "rainbow_wig_and_eyelashes_v2_f95c87006b4a37876ec9bb96783781d9.png",
  ),
  "pride-heart": createMeetFaceGraph(
    "pride_rainbow_heart",
    540,
    "face-costume",
    "pride_rainbow_heart_6debbf70a2a2f97e877ccf6adc856551.png",
  ),
  "unicorn-headband": createMeetFaceGraph(
    "unicorn_headband",
    557,
    "face-costume",
    "unicorn_headband_0b7759130a891a38b8fd326a9fb6c475.png",
  ),
  "scifi-helmet": createMeetFaceGraph(
    "scifi_space_helmet",
    563,
    "face-costume",
    "scifi_space_helmet_4038b38571ba81621e13323f18c3ac1c.png",
  ),
  "puffer-fish": createMeetFaceGraph(
    "puffer_fish_v2",
    569,
    "face-costume",
    "puffer_fish_v2_b44e456f2da58a593c6fd7d56dea8e67.png",
  ),
  sloth: createMeetFaceGraph(
    "sloth",
    590,
    "face-costume",
    "sloth_51f96af4f48a7264f9697a90bf7fe56c.png",
  ),
  owl: createMeetFaceGraph(
    "owl",
    591,
    "face-costume",
    "owl_4446490fb2a753746ce5d4ec5f207c12.png",
  ),
  pig: createMeetFaceGraph(
    "pig",
    592,
    "face-costume",
    "pig_f7bdec065e007a904d248df0f9e3b9b6.png",
  ),
  "safety-helmet": createMeetFaceGraph(
    "safety_helmet",
    602,
    "face-costume",
    "safety_helmet_333dea4ecf3bc3c10cde1f41389b3e26.png",
  ),
  "cozy-blanket": createMeetFaceGraph(
    "cozy_blanket",
    624,
    "face-costume",
    "cozy_blanket_24d960c8acb0abce989e1e73d0b519e3.png",
  ),
  "cute-astronaut": createMeetFaceGraph(
    "cute_astronaut_v2",
    559,
    "face-costume",
    "cute_astronaut_v2_826f7f71c44e370ad7032c4532b4eb48.png",
  ),
  cake: createMeetFaceGraph(
    "cake_v2",
    535,
    "face-costume",
    "cake_v2_6f9585a8b2b5bf1bcc7bb55260fe9e39.png",
  ),
  "party-hat": createMeetFaceGraph(
    "party_hat",
    622,
    "face-costume",
    "party_hat_2dfa634c933ab6b444d62494fef6a7aa.png",
  ),
  "pilot-hat": createMeetFaceGraph(
    "pilot_hat",
    620,
    "face-costume",
    "pilot_hat_abe8dbd4527b875940e81cb5759c7184.png",
  ),
  "trucker-hat": createMeetFaceGraph(
    "trucker_hat_v2",
    530,
    "face-costume",
    "trucker_hat_v2_50ed22c658e4b076ab136c8cb52337e4.png",
  ),
  "glowing-hat": createMeetFaceGraph(
    "glowing_hat_js_v2",
    369,
    "face-costume",
    "glowing_hat_js_v2_41f6fc7956fa5846d67e5587317c30a7.png",
  ),
  "noogler-hat": createMeetFaceGraph(
    "hat_noogler",
    271,
    "face-costume",
    "hat_noogler_102085b9e2820839dc24b6ad95af0196.png",
  ),
  "intern-hat": createMeetFaceGraph(
    "hat_intern",
    561,
    "face-costume",
    "hat_intern_ebdf53db94b6e876dd2ef73dee941daa.png",
  ),
  "winter-hat-scarf": createMeetFaceGraph(
    "winter_hat_and_scarf",
    516,
    "face-costume",
    "winter_hat_and_scarf_935b03038d18c74a7548fd5075aa7757.png",
  ),
  "wizard-hat": createMeetFaceGraph(
    "wizard_hat",
    582,
    "face-costume",
    "wizard_hat_81542e045cb3fe2c6ac323559ebe1aaa.png",
  ),
  "dia-de-los-muertos": createMeetFaceGraph(
    "dia_de_los_muertos_with_hat_and_mustache",
    494,
    "face-costume",
    "dia_de_los_muertos_with_hat_and_mustache_5497080b9e14182200dd800116f7f9b1.png",
  ),
  "dia-de-los-muertos-flower": createMeetFaceGraph(
    "dia_de_los_muertos_with_flower",
    493,
    "face-costume",
    "dia_de_los_muertos_with_flower_5332dfb53eacabe0140f0aa6b97a5223.png",
  ),
  pirate: createMeetFaceGraph(
    "pirate_v2",
    264,
    "face-costume",
    "pirate_v2_a8d8f01b75fa38b233ed1282223b75a5.png",
  ),
  alien: createMeetFaceGraph(
    "alien_spaceship_js_v2",
    334,
    "face-lighting",
    "alien_spaceship_js_v2_e4b827b62e026fb12d48fc655bf5bc36.png",
  ),
  "thin-mustache": createMeetFaceGraph(
    "hair_thin_mustache",
    657,
    "face-hair",
    "hair_thin_mustache_9de00a67ccbce2e2b28807cd1df13224.png",
  ),
};

export const getFaceFilterEffectGraph = (
  filter: FaceFilterId,
): FaceFilterEffectGraph | null => FACE_FILTER_EFFECT_GRAPHS[filter] ?? null;

const MEET_VIDEOPIPE_ONLY_FACE_FILTER_IDS = new Set<FaceFilterId>([
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
]);

export const requiresMeetVideoPipeFaceFilter = (
  filter: FaceFilterId,
): boolean =>
  MEET_VIDEOPIPE_ONLY_FACE_FILTER_IDS.has(filter) ||
  getFaceFilterEffectGraph(filter)?.requiresMeetVideoPipe === true;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isBackgroundEffectId = (value: unknown): value is BackgroundEffectId =>
  typeof value === "string" &&
  BACKGROUND_EFFECT_IDS.has(value as BackgroundEffectId);

const isFaceFilterId = (value: unknown): value is FaceFilterId =>
  typeof value === "string" && FACE_FILTER_IDS.has(value as FaceFilterId);

const HIDDEN_FACE_FILTER_IDS = new Set<FaceFilterId>([
  "sparkles",
  "idea",
  "glasses",
  "high-ponytail",
  "graduation-cap",
  "strawberry",
  "santa-beard",
  "dreidel",
  "valentines-panda",
  "spring",
  "dragon",
  "cowboy",
  "rusty-robot",
  "feathery-dinosaur",
  "diwali-2023",
  "film-noir",
  "octopus-on-head",
  "fried-eggs",
  "fascinator",
  "rainbow-wig",
  "pride-heart",
  "unicorn-headband",
  "scifi-helmet",
  "puffer-fish",
  "sloth",
  "owl",
  "pig",
  "safety-helmet",
  "cozy-blanket",
  "cute-glasses",
  "cyber-glasses",
  "crown",
  "halo",
  "bunny-ears",
  "cat-on-head",
  "fuzzy-cat",
  "halloween-cat",
  "velvety-dog",
  "cake",
  "party-hat",
  "pilot-hat",
  "trucker-hat",
  "glowing-hat",
  "noogler-hat",
  "intern-hat",
  "winter-hat-scarf",
  "wizard-hat",
  "dia-de-los-muertos",
  "dia-de-los-muertos-flower",
  "mustache",
  "thin-mustache",
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
]);

const isSelectableFaceFilterId = (value: unknown): value is FaceFilterId =>
  isFaceFilterId(value) &&
  (!HIDDEN_FACE_FILTER_IDS.has(value) ||
    isMeetVideoPipeSelectableFaceFilterId(value));

const isMeetVideoPipeSelectableFaceFilterId = (
  value: FaceFilterId,
): boolean => {
  const graph = getFaceFilterEffectGraph(value);
  return (
    isMeetVideoPipeRuntimeEnabled() &&
    graph?.requiresMeetVideoPipe === true &&
    typeof graph.meetEffectIdNumber === "number"
  );
};

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
    filter: isSelectableFaceFilterId(value.filter)
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
  beach: "/effects/backgrounds/beach-pavilion.webp",
  forest: "/effects/backgrounds/forest-light.webp",
  studio: "/effects/backgrounds/conference-wall.webp",
  bookshelf: "/effects/backgrounds/bookshelf.webp",
  "coffee-shop": "/effects/backgrounds/coffee-shop.webp",
  "home-office-bookshelf": "/effects/backgrounds/home-office-bookshelf.webp",
  "living-room-wide": "/effects/backgrounds/living-room-wide.webp",
  "modern-conference-room":
    "/effects/backgrounds/modern-conference-room.webp",
  "modern-indian-living-room":
    "/effects/backgrounds/modern-indian-living-room.webp",
  "office-library": "/effects/backgrounds/office-library.webp",
  "office-green-space": "/effects/backgrounds/office-green-space.webp",
  "shelf-with-plants": "/effects/backgrounds/shelf-with-plants.webp",
  "accessible-patio": "/effects/backgrounds/accessible-patio.webp",
  "camper-vacation": "/effects/backgrounds/camper-vacation.webp",
  "dog-office": "/effects/backgrounds/dog-office.webp",
  "indian-balcony": "/effects/backgrounds/indian-balcony.webp",
  "arabian-cafe-terrace":
    "/effects/backgrounds/arabian-cafe-terrace.webp",
  "ocean-terrace": "/effects/backgrounds/ocean-terrace.webp",
  "snowy-cafe": "/effects/backgrounds/snowy-cafe.webp",
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
    id: "camper-vacation",
    label: "Camper vacation",
    icon: Plane,
    tone: "#b45309",
    assetPath: BACKGROUND_ASSET_PATHS["camper-vacation"],
    category: "Immersive",
  },
  {
    id: "dog-office",
    label: "Dog office",
    icon: LampDesk,
    tone: "#57534e",
    assetPath: BACKGROUND_ASSET_PATHS["dog-office"],
    category: "Immersive",
  },
  {
    id: "indian-balcony",
    label: "Indian balcony",
    icon: Building2,
    tone: "#c2410c",
    assetPath: BACKGROUND_ASSET_PATHS["indian-balcony"],
    category: "Immersive",
  },
  {
    id: "arabian-cafe-terrace",
    label: "Arabian cafe terrace",
    icon: Coffee,
    tone: "#92400e",
    assetPath: BACKGROUND_ASSET_PATHS["arabian-cafe-terrace"],
    category: "Immersive",
  },
  {
    id: "ocean-terrace",
    label: "Ocean terrace",
    icon: Waves,
    tone: "#0284c7",
    assetPath: BACKGROUND_ASSET_PATHS["ocean-terrace"],
    category: "Immersive",
  },
  {
    id: "snowy-cafe",
    label: "Snowy cafe",
    icon: Snowflake,
    tone: "#0ea5e9",
    assetPath: BACKGROUND_ASSET_PATHS["snowy-cafe"],
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
    id: "office-library",
    label: "Office library",
    icon: LibraryBig,
    tone: "#365314",
    assetPath: BACKGROUND_ASSET_PATHS["office-library"],
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
    id: "shelf-with-plants",
    label: "Shelf with plants",
    icon: Leaf,
    tone: "#166534",
    assetPath: BACKGROUND_ASSET_PATHS["shelf-with-plants"],
    category: "Home office",
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
    id: "custom",
    label: "Uploaded image",
    icon: ImagePlus,
    tone: "#F95F4A",
    category: "Personal",
  },
];

const ALL_FACE_FILTERS: VideoEffectOption<FaceFilterId>[] = [
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
    id: "film-noir",
    label: "Film noir",
    icon: Palette,
    tone: "#18181b",
    category: "New",
  },
  {
    id: "diwali-2023",
    label: "Diwali",
    icon: Sparkles,
    tone: "#f97316",
    category: "New",
  },
  {
    id: "strawberry",
    label: "Strawberry",
    icon: Sparkles,
    tone: "#e11d48",
    category: "New",
  },
  {
    id: "pride-heart",
    label: "Rainbow heart",
    icon: Flower2,
    tone: "#7c3aed",
    category: "New",
  },
  {
    id: "spring",
    label: "Spring",
    icon: Flower2,
    tone: "#16a34a",
    category: "New",
  },
  {
    id: "valentines-panda",
    label: "Valentine panda",
    icon: Flower2,
    tone: "#db2777",
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
    id: "graduation-cap",
    label: "Graduation cap",
    icon: HatGlasses,
    tone: "#111827",
    category: "Accessories",
  },
  {
    id: "cowboy",
    label: "Cowboy",
    icon: HatGlasses,
    tone: "#92400e",
    category: "Accessories",
  },
  {
    id: "fascinator",
    label: "Fascinator",
    icon: Flower2,
    tone: "#be123c",
    category: "Accessories",
  },
  {
    id: "rainbow-wig",
    label: "Rainbow wig",
    icon: Sparkles,
    tone: "#7c3aed",
    category: "Accessories",
  },
  {
    id: "unicorn-headband",
    label: "Unicorn headband",
    icon: WandSparkles,
    tone: "#db2777",
    category: "Accessories",
  },
  {
    id: "scifi-helmet",
    label: "Sci-fi helmet",
    icon: Rocket,
    tone: "#2563eb",
    category: "Accessories",
  },
  {
    id: "safety-helmet",
    label: "Safety helmet",
    icon: HatGlasses,
    tone: "#ca8a04",
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
    id: "dragon",
    label: "Dragon",
    icon: WandSparkles,
    tone: "#16a34a",
    category: "Costumes",
  },
  {
    id: "rusty-robot",
    label: "Rusty robot",
    icon: Rocket,
    tone: "#a16207",
    category: "Costumes",
  },
  {
    id: "feathery-dinosaur",
    label: "Feathery dinosaur",
    icon: VenetianMask,
    tone: "#65a30d",
    category: "Costumes",
  },
  {
    id: "puffer-fish",
    label: "Puffer fish",
    icon: VenetianMask,
    tone: "#f97316",
    category: "Costumes",
  },
  {
    id: "sloth",
    label: "Sloth",
    icon: VenetianMask,
    tone: "#854d0e",
    category: "Costumes",
  },
  {
    id: "owl",
    label: "Owl",
    icon: VenetianMask,
    tone: "#78716c",
    category: "Costumes",
  },
  {
    id: "pig",
    label: "Pig",
    icon: VenetianMask,
    tone: "#f472b6",
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
    id: "high-ponytail",
    label: "High ponytail",
    icon: Scissors,
    tone: "#7c2d12",
    category: "Costumes",
  },
  {
    id: "hair-medium-beard",
    label: "Medium hair and beard",
    icon: Scissors,
    tone: "#3f2a1d",
    category: "Costumes",
  },
  {
    id: "long-wavy-hair",
    label: "Long wavy hair",
    icon: Scissors,
    tone: "#7c2d12",
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
    id: "cake",
    label: "Cake",
    icon: CakeSlice,
    tone: "#ec4899",
    category: "Costumes",
  },
  {
    id: "fried-eggs",
    label: "Fried eggs",
    icon: CakeSlice,
    tone: "#eab308",
    category: "Costumes",
  },
  {
    id: "octopus-on-head",
    label: "Octopus on head",
    icon: VenetianMask,
    tone: "#7c3aed",
    category: "Costumes",
  },
  {
    id: "cozy-blanket",
    label: "Cozy blanket",
    icon: Snowflake,
    tone: "#0ea5e9",
    category: "Costumes",
  },
  {
    id: "santa-beard",
    label: "Santa beard",
    icon: Snowflake,
    tone: "#dc2626",
    category: "Costumes",
  },
  {
    id: "dreidel",
    label: "Dreidel",
    icon: WandSparkles,
    tone: "#2563eb",
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

export const FACE_FILTERS: VideoEffectOption<FaceFilterId>[] =
  ALL_FACE_FILTERS.filter(
    (option) =>
      !HIDDEN_FACE_FILTER_IDS.has(option.id) ||
      isMeetVideoPipeSelectableFaceFilterId(option.id),
  );

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
  {
    id: "bloom",
    label: "Bloom",
    icon: Sparkles,
    tone: "#f59e0b",
  },
  {
    id: "moonlight",
    label: "Moonlight",
    icon: Palette,
    tone: "#2563eb",
  },
  {
    id: "sunlight",
    label: "Sunlight",
    icon: SunMedium,
    tone: "#f97316",
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
