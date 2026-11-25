export const STAGE_HOST_CLASS = "@container/stage";

export const STAGE_SPLIT_CLASS =
  "flex h-full w-full min-w-0 flex-col gap-3 @xl/stage:flex-row";

export const STAGE_RAIL_CLASS =
  "flex h-32 w-full shrink-0 flex-row gap-3 overflow-x-auto pb-1 @xl/stage:h-auto @xl/stage:w-[min(22cqw,15rem)] @xl/stage:min-w-[10rem] @xl/stage:max-w-[15rem] @xl/stage:flex-col @xl/stage:overflow-x-visible @xl/stage:overflow-y-auto @xl/stage:pb-0 @xl/stage:pr-1";

export const STAGE_RAIL_TILE_CLASS =
  "relative h-full w-28 shrink-0 @xl/stage:h-28 @xl/stage:w-auto";

export const STAGE_RAIL_SHORT_LANDSCAPE_HIDDEN_CLASS =
  "[@media(width<40rem)_and_(height<31.25rem)_and_(orientation:landscape)]:hidden";
