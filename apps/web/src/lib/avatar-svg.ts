import { FACE_SVG_DATA } from "./avatar-faces";

export const AVATAR_COLORS = [
  "#F95F4A", "#FF007A", "#7C5CFF", "#2DA8A8", "#4F86F7", "#3FA66A",
  "#F59E0B", "#14B8A6", "#E879F9", "#38BDF8", "#FF8A3D", "#FB7185",
  "#C084FC", "#6366F1", "#10B981", "#FF5EAE",
];

// Same integer hash and sphere positions as facehash (MIT; see avatar-faces).
const hashName = (name: string): number => {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = ((hash << 5) - hash + name.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
};
const POSITIONS = [[-1, 1], [1, 1], [1, 0], [0, 1], [-1, 0], [0, 0], [0, -1], [-1, -1], [1, -1]];
const FACE_TYPES = ["round", "cross", "line", "curved"] as const;
const escapeXml = (value: string): string => value.replace(/[<>&"']/g, (character) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
})[character]!);

export const renderAvatarSvg = (params: URLSearchParams): string => {
  const name = params.get("name")!;
  const rawSize = Number.parseInt(params.get("size") ?? "400", 10);
  const size = Number.isFinite(rawSize) ? Math.max(16, Math.min(rawSize, 2000)) : 400;
  const customColors = (params.get("colors") ?? "").split(",").map((color) => color.trim())
    .filter((color) => /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(color));
  const colors = customColors.length ? customColors : AVATAR_COLORS;
  const hash = hashName(name);
  const face = FACE_SVG_DATA[FACE_TYPES[hash % FACE_TYPES.length]];
  const color = colors[hash % colors.length];
  const [rotationX, rotationY] = params.get("pose") === "front" ? [0, 0] : POSITIONS[hash % POSITIONS.length];
  const [, , width, height] = face.viewBox.split(" ").map(Number);
  const faceWidth = size * 0.6;
  const faceHeight = faceWidth * height / width;
  const showInitial = ["true", "1"].includes(params.get("showInitial") ?? "false");
  const initialHeight = showInitial ? size * 0.34 : 0;
  const x = (size - faceWidth) / 2 + rotationY * size * 0.05;
  const y = (size - faceHeight - initialHeight) / 2 - rotationX * size * 0.05;
  const gradient = params.get("variant") !== "solid";
  const initial = Array.from(name)[0]?.toUpperCase().replace(/[\u0000-\u001f\ufffe\uffff]/g, "") ?? "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<rect width="${size}" height="${size}" fill="${color}"/>
${gradient ? `<defs><radialGradient id="glow"><stop stop-color="white" stop-opacity=".15"/><stop offset=".6" stop-color="white" stop-opacity="0"/></radialGradient></defs><rect width="${size}" height="${size}" fill="url(#glow)"/>` : ""}
<svg x="${x}" y="${y}" width="${faceWidth}" height="${faceHeight}" viewBox="${face.viewBox}" fill="black">${face.paths.map((path) => `<path d="${path}"/>`).join("")}</svg>
${showInitial ? `<text x="${size / 2 + rotationY * size * 0.05}" y="${y + faceHeight + size * 0.3}" text-anchor="middle" font-family="monospace" font-weight="700" font-size="${size * 0.26}">${escapeXml(initial)}</text>` : ""}
</svg>`;
};
