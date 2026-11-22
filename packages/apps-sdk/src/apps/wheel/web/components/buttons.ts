const BASE =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-lg text-[13px] transition-[background-color,color,transform] duration-100 ease-out active:scale-[0.97] disabled:cursor-not-allowed disabled:active:scale-100";

export const PRIMARY_BUTTON = `${BASE} h-10 bg-[#F95F4A] px-6 font-semibold text-white hover:bg-[#ff7059] disabled:bg-[#232327] disabled:text-[#fafafa]/40`;

export const SECONDARY_BUTTON = `${BASE} h-10 border border-white/[0.14] px-4 font-medium text-[#fafafa]/90 hover:bg-white/[0.06] disabled:opacity-35`;

export const GHOST_BUTTON = `${BASE} h-10 px-3 font-medium text-[#fafafa]/75 hover:bg-white/[0.06] hover:text-[#fafafa] disabled:opacity-35 disabled:hover:bg-transparent`;

export const ICON_BUTTON = `${BASE} h-8 w-8 text-[#fafafa]/60 hover:bg-white/[0.06] hover:text-[#fafafa] disabled:opacity-35 disabled:hover:bg-transparent`;
