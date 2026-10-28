import jwt, { type JwtPayload } from "jsonwebtoken";

export const OCS_CLIENT_ID = "ocs27";
export const isOcsRoom = (roomId: string): boolean =>
  /^ocs27-[a-z0-9-]{8,58}$/.test(roomId);

export type OcsJoinRole = "candidate" | "interviewer" | "ghost";
export type OcsJoinClaims = JwtPayload & {
  sub: string;
  roomId: string;
  bookingId: string;
  role: OcsJoinRole;
  name: string;
  email: string;
  exp: number;
};

export function verifyOcsJoinCapability(
  token: string,
  roomId: string,
): OcsJoinClaims | null {
  const secret = process.env.OCS27_CONCLAVE_SIGNING_KEY;
  if (
    !secret ||
    secret.length < 32 ||
    token.length > 4096 ||
    !isOcsRoom(roomId)
  )
    return null;
  try {
    const claims = jwt.verify(token, secret, {
      algorithms: ["HS256"],
      issuer: "ocs27",
      audience: "conclave-ocs27",
      maxAge: "2m",
    });
    if (!claims || typeof claims === "string") return null;
    const value = claims as OcsJoinClaims;
    if (
      value.roomId !== roomId ||
      !["candidate", "interviewer", "ghost"].includes(value.role) ||
      typeof value.sub !== "string" ||
      !value.sub ||
      value.sub.length > 128 ||
      typeof value.bookingId !== "string" ||
      !value.bookingId ||
      value.bookingId.length > 128 ||
      typeof value.name !== "string" ||
      !value.name ||
      value.name.length > 128 ||
      typeof value.email !== "string" ||
      !value.email ||
      value.email.length > 256 ||
      typeof value.exp !== "number" ||
      value.exp > Math.floor(Date.now() / 1000) + 120 ||
      typeof value.iat !== "number" ||
      value.iat > Math.floor(Date.now() / 1000)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
