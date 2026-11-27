import { describe, expect, it, vi } from "vitest";
import { beginJoinRequest } from "../src/app/lib/join-requests";

// One tab's join requests on its connection, each settled the way the
// client's join settles it: with the server's answer, or an error.
const twoRequests = () => {
  const newest = { current: 0 };
  const settled = () => {
    const resolve = vi.fn();
    const reject = vi.fn();
    return { resolve, reject };
  };
  const older = settled();
  const olderRequest = beginJoinRequest(newest);
  const olderSettle = olderRequest.settleWith<"joined" | "waiting">(older.resolve, older.reject);
  const newer = settled();
  const newerRequest = beginJoinRequest(newest);
  const newerSettle = newerRequest.settleWith<"joined" | "waiting">(newer.resolve, newer.reject);
  return { older, olderRequest, olderSettle, newer, newerRequest, newerSettle };
};

describe("a tab's join requests", () => {
  it("settle the newest request with the server's answer", () => {
    const { newer, newerRequest, newerSettle } = twoRequests();
    expect(newerRequest.isNewest()).toBe(true);
    newerSettle.resolve("joined");
    expect(newer.resolve).toHaveBeenCalledWith("joined");
  });

  it("settle an overtaken request as overtaken, whatever the server answered", () => {
    const { older, olderRequest, olderSettle } = twoRequests();
    expect(olderRequest.isNewest()).toBe(false);
    olderSettle.resolve("waiting");
    expect(older.resolve).toHaveBeenCalledWith("overtaken");
  });

  it("settle an overtaken request that failed as overtaken, not as an error", () => {
    const { older, olderSettle } = twoRequests();
    olderSettle.reject(new Error("A newer join from this connection took over."));
    expect(older.reject).not.toHaveBeenCalled();
    expect(older.resolve).toHaveBeenCalledWith("overtaken");
  });

  it("still report a failure of the newest request", () => {
    const { newer, newerSettle } = twoRequests();
    const failure = new Error("No room found.");
    newerSettle.reject(failure);
    expect(newer.reject).toHaveBeenCalledWith(failure);
  });
});
