import { describe, expect, it } from "vitest";
import {
  getDisplayableHotkeys,
  HOTKEY_LIST,
  HOTKEYS,
} from "../src/app/lib/hotkeys";

describe("getDisplayableHotkeys", () => {
  it("filters out declared-but-unbound actions", () => {
    // These exist in the map for labeling purposes but have no binding yet;
    // a shortcuts reference row with an empty key chip would be noise.
    expect(HOTKEYS.toggleReactions.keys).toBe("");
    expect(HOTKEYS.toggleApps.keys).toBe("");

    const actions = getDisplayableHotkeys().map((h) => h.action);
    expect(actions).not.toContain("toggleReactions");
    expect(actions).not.toContain("toggleApps");
  });

  it("keeps every bound hotkey, including the palette and help bindings", () => {
    const displayable = getDisplayableHotkeys();
    const bound = HOTKEY_LIST.filter((h) => h.keys.length > 0);
    expect(new Set(displayable.map((h) => h.action))).toEqual(
      new Set(bound.map((h) => h.action)),
    );
    expect(displayable).toHaveLength(bound.length);

    const actions = displayable.map((h) => h.action);
    expect(actions).toContain("commandPalette");
    expect(actions).toContain("shortcutsHelp");
  });

  it("puts the quick-actions palette at the top of the list", () => {
    expect(getDisplayableHotkeys()[0]?.action).toBe("commandPalette");
  });

  it("provides a label and description for every displayable row", () => {
    for (const hotkey of getDisplayableHotkeys()) {
      expect(hotkey.label.length).toBeGreaterThan(0);
      expect(hotkey.description.length).toBeGreaterThan(0);
    }
  });
});
