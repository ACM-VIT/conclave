import { describe, expect, it } from "vitest";
import type { MeetSelfViewCorner } from "../src/app/lib/meet-view";
import {
  LOCAL_TILE_ID,
  OVERFLOW_TILE_ID,
  PRESENTATION_TILE_ID,
  resolveContentStagePlacement,
  resolveMeetingStageLayout,
  resolveTiledGridPlacement,
  type MeetingStageLayout,
  type MeetingStageTile,
  type SelfViewRequest,
} from "../src/app/lib/meeting-stage-layout";
import {
  overlapArea,
  tileControlsRect,
  type StageRect,
} from "../src/app/lib/stage-overlay";
import type { Participant } from "../src/app/lib/types";

const remote = (userId: string) => ({ userId }) as Participant;
const camera = (userId: string) => ({ kind: "remote" as const, participant: remote(userId) });

const CORNERS: MeetSelfViewCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
const CHAT_OPEN = 424;
const STAGE_CHROME = { width: 64, height: 136 };
const stageSize = (viewportWidth: number, viewportHeight: number, chatOpen: boolean) => ({
  width: viewportWidth - STAGE_CHROME.width - (chatOpen ? CHAT_OPEN - 64 : 0),
  height: viewportHeight - STAGE_CHROME.height,
});
const VIEWPORTS = [
  [1280, 900], [1280, 300], [1280, 275], [1280, 260], [1280, 245],
  [1024, 260], [1024, 245], [768, 260], [640, 300], [640, 275], [640, 260],
] as const;

type Scenario = {
  name: string;
  remotes: string[];
  pinned: string | null;
  companion: string | null;
  presenting: boolean;
  spotlight: boolean;
};

const SCENARIOS: Scenario[] = [
  { name: "pinned camera with a share", remotes: ["bob", "carol"], pinned: "bob", companion: null, presenting: true, spotlight: false },
  { name: "share in the sidebar", remotes: ["bob", "carol", "dave"], pinned: null, companion: null, presenting: true, spotlight: false },
  { name: "share with a companion", remotes: ["bob", "carol", "dave"], pinned: null, companion: "bob", presenting: true, spotlight: false },
  { name: "share in spotlight", remotes: ["bob", "carol"], pinned: null, companion: null, presenting: true, spotlight: true },
  { name: "pinned camera", remotes: ["bob", "carol", "dave", "erin"], pinned: "carol", companion: null, presenting: false, spotlight: false },
  { name: "speaker in spotlight", remotes: ["bob"], pinned: null, companion: null, presenting: false, spotlight: true },
  { name: "crowded sidebar", remotes: ["bob", "carol", "dave", "erin", "frank", "grace", "heidi", "ivan", "judy"], pinned: null, companion: null, presenting: false, spotlight: false },
];

const resolve = (
  scenario: Scenario,
  size: { width: number; height: number },
  selfView: SelfViewRequest,
  galleryOpen = false,
) =>
  resolveMeetingStageLayout({
    size,
    participants: scenario.remotes.map(remote),
    preferredCamera: camera(scenario.remotes[0]),
    pinnedCamera: scenario.pinned ? camera(scenario.pinned) : null,
    companionCamera: scenario.companion ? camera(scenario.companion) : null,
    presenting: scenario.presenting,
    spotlight: scenario.spotlight,
    selfView,
    galleryOpen,
    maxTiles: 8,
  })!;

const placedTiles = (layout: MeetingStageLayout) => {
  const placed: Array<{ tile: MeetingStageTile | "overflow"; rect: StageRect }> = [
    { tile: layout.main, rect: layout.rects.main },
    ...layout.rail.map((tile, index) => ({ tile, rect: layout.rects.rail[index] })),
  ];
  if (layout.companion && layout.rects.companion) {
    placed.push({ tile: layout.companion, rect: layout.rects.companion });
  }
  if (layout.compactPin && layout.rects.compactPin) {
    placed.push({ tile: layout.compactPin, rect: layout.rects.compactPin });
  }
  if (layout.rects.overflow) placed.push({ tile: "overflow", rect: layout.rects.overflow });
  return placed;
};

const same = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

const stageViolations = (
  layout: MeetingStageLayout,
  scenario: Scenario,
  size: { width: number; height: number },
) => {
  const violations: string[] = [];
  const check = (holds: boolean, rule: string) => {
    if (!holds) violations.push(rule);
  };
  const placed = placedTiles(layout);
  const kinds = layout.tiles.map((tile) => tile.kind);
  const remotesPlaced = layout.tiles.flatMap((tile) =>
    tile.kind === "remote" ? [tile.participant.userId] : [],
  );
  const inside = (rect: StageRect) =>
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.width <= size.width + 0.001 &&
    rect.y + rect.height <= size.height + 0.001;

  check(kinds.includes("presentation") === scenario.presenting, "a live share is placed");
  check(layout.hints.presentation.visible === scenario.presenting, "a placed share is reported visible");
  check(same(layout.hints.visibleRemoteIds, remotesPlaced), "visible cameras are the placed cameras");
  check(
    same(
      layout.hints.primaryIds.filter((id) => id !== PRESENTATION_TILE_ID && id !== LOCAL_TILE_ID),
      remotesPlaced,
    ),
    "primary cameras are the placed cameras",
  );
  check(
    same(
      [...layout.hints.visibleRemoteIds, ...layout.hints.hiddenIds].sort(),
      [...scenario.remotes].sort(),
    ),
    "every camera is visible or hidden, never both",
  );
  check(!scenario.pinned || remotesPlaced.includes(scenario.pinned), "a pinned camera is placed");
  check(placed.every(({ rect }) => inside(rect)), "tiles stay inside the stage");

  const { placement, rect: overlay } = layout.selfView;
  const selfTiles = kinds.filter((kind) => kind === "local").length;
  check(
    selfTiles === (placement === "tile" || placement === "stage" ? 1 : 0),
    "the self-view is placed once",
  );
  check(
    (overlay !== null) === (placement === "floating" || placement === "minimized"),
    "a detached self-view has a rect",
  );
  if (!overlay) return violations;

  check(inside(overlay), "the self-view stays inside the stage");
  for (const { tile, rect } of placed) {
    if (tile !== "overflow" && (tile.kind === "presentation" || tile === layout.compactPin)) {
      check(overlapArea(overlay, rect) === 0, "the self-view covers no share or compact pin");
      continue;
    }
    check(overlapArea(overlay, tileControlsRect(rect)) === 0, "the self-view covers no tile controls");
    check(
      overlapArea(overlay, rect) * 2 <= rect.width * rect.height,
      "the self-view covers at most half a tile",
    );
  }
  return violations;
};

describe("floating self-view on the stage", () => {
  const pinnedShare = SCENARIOS[0];

  it("leaves the share and the pinned camera's Unpin control clear at 1280 x 900 with chat open", () => {
    const size = stageSize(1280, 900, true);
    const layout = resolve(pinnedShare, size, { mode: "floating", corner: "top-right" });
    const share = layout.rects.rail[layout.rail.findIndex((tile) => tile.kind === "presentation")];

    expect(layout.main).toMatchObject({ kind: "remote", participant: { userId: "bob" } });
    expect(layout.selfView.placement).toBe("floating");
    expect(layout.selfView.corner).toBe("top-left");
    expect(overlapArea(layout.selfView.rect!, share)).toBe(0);
    expect(overlapArea(layout.selfView.rect!, tileControlsRect(layout.rects.main))).toBe(0);
  });

  it("takes a free rail slot when a share is the main tile and no corner is clear", () => {
    const layout = resolve(SCENARIOS[1], stageSize(1280, 900, true), {
      mode: "floating",
      corner: "top-left",
    });

    expect(layout.main.kind).toBe("presentation");
    expect(layout.selfView).toEqual({ placement: "tile", corner: "top-left", rect: null });
    expect(layout.rail.map((tile) => tile.kind)).toEqual(["local", "remote", "remote", "remote"]);
    expect(layout.hints.hiddenIds).toEqual([]);
  });

  it("is not shown when a rail slot would hide another camera", () => {
    const size = stageSize(1280, 300, true);
    const floating = resolve(SCENARIOS[1], size, { mode: "floating", corner: "top-left" });
    const tiled = resolve(SCENARIOS[1], size, { mode: "tile", corner: "top-left" });

    expect(tiled.rail.map((tile) => tile.kind)).toEqual(["local"]);
    expect(tiled.overflow).toBe(false);
    expect(floating.selfView.placement).toBe("none");
    expect(floating.rail).toEqual([]);
    expect(floating.overflow).toBe(true);
  });

  it("never covers the Auto companion at 1024 x 245 with chat open", () => {
    const size = stageSize(1024, 245, true);
    for (const corner of CORNERS) {
      const layout = resolve(SCENARIOS[2], size, { mode: "floating", corner });
      expect(layout.companion).toMatchObject({ participant: { userId: "bob" } });
      expect(layout.hints.visibleRemoteIds).toContain("bob");
      expect(layout.selfView.rect).toBeNull();
    }
  });

  it("is not shown over a share in spotlight", () => {
    for (const corner of CORNERS) {
      const layout = resolve(SCENARIOS[3], stageSize(1280, 900, false), { mode: "floating", corner });
      expect(layout.selfView).toEqual({ placement: "none", corner, rect: null });
    }
  });

  it("keeps the requested corner when it is clear", () => {
    const layout = resolve(SCENARIOS[5], stageSize(1280, 900, false), {
      mode: "floating",
      corner: "bottom-right",
    });
    expect(layout.selfView).toMatchObject({ placement: "floating", corner: "bottom-right" });
  });

  it.each(SCENARIOS)("holds every placement rule for $name", (scenario) => {
    const failures: string[] = [];
    for (const [width, height] of VIEWPORTS) {
      for (const chatOpen of [true, false]) {
        const size = stageSize(width, height, chatOpen);
        for (const corner of CORNERS) {
          for (const mode of ["floating", "minimized", "tile"] as const) {
            const layout = resolve(scenario, size, { mode, corner });
            for (const rule of stageViolations(layout, scenario, size)) {
              failures.push(`${width}x${height} chat ${chatOpen} ${mode} ${corner}: ${rule}`);
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it.each(SCENARIOS)("holds every placement rule across stage sizes for $name", (scenario) => {
    const failures: string[] = [];
    for (let width = 180; width <= 1500; width += 41) {
      for (let height = 100; height <= 900; height += 37) {
        const size = { width, height };
        for (const corner of CORNERS) {
          for (const mode of ["floating", "minimized"] as const) {
            const layout = resolve(scenario, size, { mode, corner });
            for (const rule of stageViolations(layout, scenario, size)) {
              failures.push(`${width}x${height} ${mode} ${corner}: ${rule}`);
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("counts gallery cameras as visible but not primary while the gallery is open", () => {
    const crowded = SCENARIOS[6];
    const size = stageSize(1280, 900, true);
    const closed = resolve(crowded, size, { mode: "tile", corner: "bottom-right" });
    const open = resolve(crowded, size, { mode: "tile", corner: "bottom-right" }, true);

    expect(closed.overflow).toBe(true);
    expect(closed.hints.hiddenIds.length).toBeGreaterThan(0);
    expect(open.hints.hiddenIds).toEqual([]);
    expect([...open.hints.visibleRemoteIds].sort()).toEqual([...crowded.remotes].sort());
    expect(open.hints.primaryIds).toEqual(closed.hints.primaryIds);
  });

  it("keeps the requested self-view until the stage is measured", () => {
    const layout = resolve(pinnedShare, { width: 0, height: 0 }, { mode: "floating", corner: "top-right" });
    expect(layout.selfView).toEqual({ placement: "floating", corner: "top-right", rect: null });
  });
});

describe("floating self-view on the tiled grid", () => {
  const size = { width: 1216, height: 664 };
  const half = (size.width - 12) / 2;
  const tiles = [
    { id: PRESENTATION_TILE_ID, rect: { x: 0, y: 163, width: half, height: 338 } },
    { id: "bob", rect: { x: half + 12, y: 163, width: half, height: 338 } },
  ];

  it.each(CORNERS)("never covers a share tile from %s", (corner) => {
    const placement = resolveTiledGridPlacement({
      size,
      tiles,
      hiddenIds: [],
      galleryOpen: false,
      selfView: { mode: "floating", corner },
    });

    expect(placement.selfView.placement).toBe("floating");
    expect(placement.selfView.corner).toBe(corner);
    expect(overlapArea(placement.selfView.rect!, tiles[0].rect)).toBe(0);
    expect(placement.hints).toEqual({
      visibleRemoteIds: ["bob"],
      primaryIds: [PRESENTATION_TILE_ID, "bob"],
      hiddenIds: [],
      presentation: { visible: true, primary: true },
    });
  });

  it("moves off a share that fills its corner", () => {
    const full = [
      { id: PRESENTATION_TILE_ID, rect: { x: 0, y: 0, width: half, height: size.height } },
      { id: "bob", rect: { x: half + 12, y: 0, width: half, height: size.height } },
    ];
    const placement = resolveTiledGridPlacement({
      size,
      tiles: full,
      hiddenIds: [],
      galleryOpen: false,
      selfView: { mode: "floating", corner: "bottom-left" },
    });

    expect(placement.selfView.corner).toBe("bottom-right");
    expect(overlapArea(placement.selfView.rect!, full[0].rect)).toBe(0);
  });

  it("reports overflow cameras hidden until the gallery opens", () => {
    const grid = [
      { id: LOCAL_TILE_ID, rect: { x: 0, y: 0, width: half, height: 300 } },
      { id: "bob", rect: { x: half + 12, y: 0, width: half, height: 300 } },
      { id: OVERFLOW_TILE_ID, rect: { x: 0, y: 312, width: half, height: 300 } },
    ];
    const closed = resolveTiledGridPlacement({
      size,
      tiles: grid,
      hiddenIds: ["carol", "dave"],
      galleryOpen: false,
      selfView: { mode: "tile", corner: "bottom-right" },
    });
    const open = resolveTiledGridPlacement({
      size,
      tiles: grid.slice(0, 2),
      hiddenIds: ["carol", "dave"],
      galleryOpen: true,
      selfView: { mode: "tile", corner: "bottom-right" },
    });

    expect(closed.selfView.placement).toBe("tile");
    expect(closed.hints.visibleRemoteIds).toEqual(["bob"]);
    expect(closed.hints.hiddenIds).toEqual(["carol", "dave"]);
    expect(open.hints.visibleRemoteIds).toEqual(["bob", "carol", "dave"]);
    expect(open.hints.hiddenIds).toEqual([]);
  });
});

describe("app and shared browser stage", () => {
  const participants = ["bob", "carol"].map(remote);

  it("reports no camera visible when the stage has no room for a rail", () => {
    const placement = resolveContentStagePlacement({
      size: { width: 216, height: 139 },
      participants,
      railAllowed: true,
      railWindow: null,
    });

    expect(placement.split.mode).toBe("main-only");
    expect(placement.rail).toEqual([]);
    expect(placement.hints).toEqual({
      visibleRemoteIds: [],
      primaryIds: [],
      hiddenIds: ["bob", "carol"],
      presentation: { visible: false, primary: false },
    });
  });

  it("reports no camera visible when the viewport rules out the rail", () => {
    const placement = resolveContentStagePlacement({
      size: { width: 1216, height: 664 },
      participants,
      railAllowed: false,
      railWindow: null,
    });

    expect(placement.rail).toEqual([]);
    expect(placement.hints.visibleRemoteIds).toEqual([]);
    expect(placement.hints.hiddenIds).toEqual(["bob", "carol"]);
  });

  it("reports only the rail cameras inside the rail's scroll window", () => {
    const crowd = ["bob", "carol", "dave", "erin"].map(remote);
    const resolveWindow = (first: number, last: number) =>
      resolveContentStagePlacement({
        size: { width: 1216, height: 164 },
        participants: crowd,
        railAllowed: true,
        railWindow: { first, last },
      }).hints;

    expect(resolveWindow(0, 1)).toMatchObject({
      visibleRemoteIds: ["bob"],
      primaryIds: [LOCAL_TILE_ID, "bob"],
      hiddenIds: ["carol", "dave", "erin"],
    });
    expect(resolveWindow(3, 4)).toMatchObject({
      visibleRemoteIds: ["dave", "erin"],
      primaryIds: ["dave", "erin"],
      hiddenIds: ["bob", "carol"],
    });
    expect(resolveWindow(-1, -1)).toMatchObject({
      visibleRemoteIds: [],
      primaryIds: [],
      hiddenIds: ["bob", "carol", "dave", "erin"],
    });
  });

  it("reports every rail camera visible and primary when the rail is shown", () => {
    const placement = resolveContentStagePlacement({
      size: { width: 1216, height: 664 },
      participants,
      railAllowed: true,
      railWindow: null,
    });

    expect(placement.split.mode).toBe("side");
    expect(placement.rail.map((tile) => tile.kind)).toEqual(["local", "remote", "remote"]);
    expect(placement.hints).toEqual({
      visibleRemoteIds: ["bob", "carol"],
      primaryIds: [LOCAL_TILE_ID, "bob", "carol"],
      hiddenIds: [],
      presentation: { visible: false, primary: false },
    });
  });
});
