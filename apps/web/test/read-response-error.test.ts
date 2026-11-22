import { describe, expect, it } from "vitest";
import { readResponseError } from "../src/app/lib/utils";

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("reading an error from an SFU or API response", () => {
  it("tells the user to try again when the change could not be saved", async () => {
    const response = reply(503, { error: "persistence_unavailable", message: "Couldn't save, try again." });
    expect(await readResponseError(response)).toBe("Couldn't save, try again.");
  });

  it("keeps any other error message as it is", async () => {
    expect(await readResponseError(reply(400, { error: "Title is required." }))).toBe("Title is required.");
    expect(await readResponseError(new Response("not json", { status: 502, statusText: "Bad Gateway" }))).toBe("Bad Gateway");
  });
});
