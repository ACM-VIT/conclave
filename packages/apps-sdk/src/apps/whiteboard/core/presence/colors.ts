const COLORS = [
  "#a8a5ff",
  "#4ADE80",
  "#60A5FA",
  "#FBBF24",
  "#FB7185",
  "#34D399",
  "#F97316",
  "#e879f9",
];

export const getColorForUser = (userId: string) => {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) {
    hash = (hash << 5) - hash + userId.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % COLORS.length;
  return COLORS[index];
};
