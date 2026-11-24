import { describe, expect, it } from "vitest";
import { wireBytes } from "../server/socket/wireBytes.js";
import { seededRandom } from "./support/appsRoom.js";

const previousDecode = (value: string): Uint8Array | null => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  return Uint8Array.from(Buffer.from(trimmed, "base64"));
};

const WHITESPACE = [" ", "\t", "\n", "\r", "\v", "\f", " ", " ", "﻿", "　"];
const NOISE = ["=", "-", "_", "*", "A", "/", "+", "é"];

describe("wire bytes", () => {
  it("measures exactly what it reads, for every encoding the SFU takes", () => {
    const random = seededRandom(270);
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
    let checked = 0;
    for (let round = 0; round < 4000; round += 1) {
      const bytes = Uint8Array.from({ length: Math.floor(random() * 40) }, () => Math.floor(random() * 256));
      const base64 = Buffer.from(bytes).toString("base64");
      const pad = () => Array.from({ length: Math.floor(random() * 3) }, () => pick(WHITESPACE)).join("");
      let mangled = base64;
      if (random() < 0.5 && mangled.length > 0) {
        const at = Math.floor(random() * (mangled.length + 1));
        mangled = mangled.slice(0, at) + pick(NOISE) + mangled.slice(at + (random() < 0.5 ? 1 : 0));
      }
      if (random() < 0.3) mangled = mangled.replace(/=+$/, "");
      const forms: unknown[] = [
        bytes,
        Buffer.from(bytes),
        bytes.slice().buffer,
        new DataView(bytes.slice().buffer),
        Array.from(bytes),
        { type: "Buffer", data: Array.from(bytes) },
        base64,
        `${pad()}${base64}${pad()}`,
        `${pad()}${mangled}${pad()}`,
      ];
      for (const form of forms) {
        const wire = wireBytes(form);
        const read = wire?.read() ?? null;
        if (typeof form === "string") {
          const expected = previousDecode(form);
          expect(read === null, JSON.stringify(form)).toBe(expected === null);
          if (expected) expect(read).toEqual(expected);
        } else {
          expect(read && Uint8Array.from(read)).toEqual(bytes);
        }
        if (read) {
          expect(wire?.length, JSON.stringify(form)).toBe(read.length);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(20000);
  });

  it("refuses what it cannot read without reading it", () => {
    expect([null, undefined, 0, "", "   ", {}, { type: "Buffer" }, 12].map((value) => wireBytes(value))).toEqual(
      Array(8).fill(null),
    );
    expect(["A", "AB", "ABC", "A===", "===="].map((value) => wireBytes(value))).toEqual(Array(5).fill(null));
    expect(wireBytes(["a", 1])?.read()).toBeNull();
    expect(wireBytes("A=A=")?.read()).toBeNull();
  });
});
