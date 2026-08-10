import { describe, expect, it } from "vitest";
import { isSafeSharedBrowserSearchField } from "../src/app/api/conclave/assistant/route";

describe("@Conclave shared-browser tool policy", () => {
  it("allows typing only into GET search fields", () => {
    expect(
      isSafeSharedBrowserSearchField({
        id: "search",
        tag: "input",
        inputType: "search",
        formMethod: "get",
        isSearchForm: true,
      }),
    ).toBe(true);

    expect(
      isSafeSharedBrowserSearchField({
        id: "message",
        tag: "textarea",
        label: "Send a message",
        formMethod: "post",
      }),
    ).toBe(false);

    expect(
      isSafeSharedBrowserSearchField({
        id: "comment",
        tag: "textarea",
        label: "Comment",
        formMethod: "get",
      }),
    ).toBe(false);
  });
});
