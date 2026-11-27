import { describe, expect, it } from "vitest";
import { wireBytes } from "../server/socket/wireBytes.js";
import { seededRandom } from "./support/appsRoom.js";

const strictDecode = (value: string): Uint8Array | null => {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  return Uint8Array.from(Buffer.from(value, "base64"));
};

const WHITESPACE = [" ", "\t", "\n", "\r", "\v", "\f", " ", " ", "﻿", "　"];
const NOISE = ["=", "-", "_", "*", "A", "/", "+", "é"];

describe("wire bytes", () => {
  it("inspects at most two base64 characters before a caller pays to read", () => {
    const random = seededRandom(270);
    const frames = Array.from({ length: 128 }, (_, index) => {
      const length = 4 * (1 + Math.floor(random() * (index < 64 ? 128 : 250_000)));
      const text = ["A", " ", "\n", "=", "-", "é"][index % 6].repeat(length - 4);
      const tail = ["AAAA", "AAA=", "AA==", "====", "\r\n  "][index % 5];
      return JSON.parse(JSON.stringify(index % 2 ? text + tail : tail + text)) as string;
    });
    const charCodeAt = Object.getOwnPropertyDescriptor(String.prototype, "charCodeAt")?.value as typeof String.prototype.charCodeAt;
    const trim = Object.getOwnPropertyDescriptor(String.prototype, "trim")?.value as typeof String.prototype.trim;
    const exec = Object.getOwnPropertyDescriptor(RegExp.prototype, "exec")?.value as typeof RegExp.prototype.exec;
    const from = Object.getOwnPropertyDescriptor(Buffer, "from")?.value as typeof Buffer.from;
    let characters = 0;
    let bulk = 0;
    let observed = 0;
    const counts: { characters: number; bulk: number }[] = [];
    try {
      String.prototype.charCodeAt = function (index) {
        characters += 1;
        return charCodeAt.call(this, index);
      };
      String.prototype.trim = function () {
        bulk += 1;
        return trim.call(this);
      };
      RegExp.prototype.exec = function (value) {
        bulk += 1;
        return exec.call(this, value);
      };
      Buffer.from = ((...args: unknown[]) => {
        bulk += 1;
        return Reflect.apply(from, Buffer, args) as Buffer;
      }) as typeof Buffer.from;
      for (const frame of frames) {
        characters = 0;
        bulk = 0;
        if (wireBytes(frame)) observed += 1;
        counts.push({ characters, bulk });
      }
    } finally {
      String.prototype.charCodeAt = charCodeAt;
      String.prototype.trim = trim;
      RegExp.prototype.exec = exec;
      Buffer.from = from;
    }
    expect(observed).toBeGreaterThan(0);
    expect(Math.max(...counts.map((count) => count.bulk))).toBe(0);
    expect(Math.max(...counts.map((count) => count.characters))).toBeLessThanOrEqual(2);
  });

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
          const expected = strictDecode(form);
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

  it("refuses base64 with surrounding whitespace, which no client sends", () => {
    for (const padded of [" AAAA", "AAAA ", "\nAAAA", "AAAA\r\n", " AA= "]) expect(wireBytes(padded)?.read() ?? null).toBeNull();
  });

  it("refuses what it cannot read without reading it", () => {
    expect([null, undefined, 0, "", "   ", {}, { type: "Buffer" }, 12].map((value) => wireBytes(value))).toEqual(
      Array(8).fill(null),
    );
    expect(["A", "AB", "ABC", "AAAAA"].map((value) => wireBytes(value))).toEqual(Array(4).fill(null));
    expect(["A===", "====", "AA=A"].map((value) => wireBytes(value)?.read())).toEqual(Array(3).fill(null));
    expect(wireBytes(["a", 1])?.read()).toBeNull();
    expect(wireBytes("A=A=")?.read()).toBeNull();
  });
});
