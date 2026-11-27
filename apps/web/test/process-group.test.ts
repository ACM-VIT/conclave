import { describe, expect, it } from "vitest";
import { hasLiveMembers } from "../scripts/process-group.mjs";

describe("process group liveness", () => {
  it("counts zombies as exited, since no init may ever reap them", () => {
    expect(hasLiveMembers(4242, [
      { pgid: 4242, state: "Z" },
      { pgid: 4242, state: "Z+" },
      { pgid: 1, state: "S" },
    ])).toBe(false);
  });

  it("is alive while any member is running or sleeping", () => {
    expect(hasLiveMembers(4242, [
      { pgid: 4242, state: "Z" },
      { pgid: 4242, state: "S" },
    ])).toBe(true);
    expect(hasLiveMembers(4242, [{ pgid: 4242, state: "R+" }])).toBe(true);
  });

  it("is gone when no process is in the group", () => {
    expect(hasLiveMembers(4242, [{ pgid: 7, state: "S" }])).toBe(false);
  });
});
