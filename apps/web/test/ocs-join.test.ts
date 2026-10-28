import jwt from "jsonwebtoken";
import { afterEach, describe, expect, it } from "vitest";
import { verifyOcsJoinCapability } from "../src/lib/ocs-join";

const key = "test-only-key-with-at-least-thirty-two-characters";
const roomId = "ocs27-interview-001";
const previousKey = process.env.OCS27_CONCLAVE_SIGNING_KEY;
const issue = (overrides: Record<string, unknown> = {}) =>
  jwt.sign(
    {
      sub: "profile-1",
      roomId,
      bookingId: "booking-1",
      role: "candidate",
      name: "Candidate",
      email: "candidate@vitstudent.ac.in",
      ...overrides,
    },
    key,
    {
      algorithm: "HS256",
      issuer: "ocs27",
      audience: "conclave-ocs27",
      expiresIn: "2m",
    },
  );

afterEach(() => {
  if (previousKey === undefined) delete process.env.OCS27_CONCLAVE_SIGNING_KEY;
  else process.env.OCS27_CONCLAVE_SIGNING_KEY = previousKey;
});

describe("OCS interview join capability", () => {
  it("accepts only a signed token for its exact room", () => {
    process.env.OCS27_CONCLAVE_SIGNING_KEY = key;
    expect(verifyOcsJoinCapability(issue(), roomId)?.role).toBe("candidate");
    expect(verifyOcsJoinCapability(issue(), "ocs27-another-room")).toBeNull();
    expect(
      verifyOcsJoinCapability(issue({ role: "admin" }), roomId),
    ).toBeNull();
    expect(
      verifyOcsJoinCapability(issue({ roomId: "public-room" }), roomId),
    ).toBeNull();
  });

  it("fails closed without configuration or with a forged signature", () => {
    const token = issue();
    delete process.env.OCS27_CONCLAVE_SIGNING_KEY;
    expect(verifyOcsJoinCapability(token, roomId)).toBeNull();
    process.env.OCS27_CONCLAVE_SIGNING_KEY = key;
    expect(
      verifyOcsJoinCapability(token.replace(/\.[^.]+$/, ".invalid"), roomId),
    ).toBeNull();
  });
});
