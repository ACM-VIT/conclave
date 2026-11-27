# 0026. One stage placement owns tiles, the self-view overlay and the download hints

- Status: Accepted
- Date: 2026-11-27

## Context

The web meeting stage decides three things from the same facts: where each tile goes, whether a pinned camera stays reachable, and which cameras the client downloads. The download policy (`useAdaptiveConsumerPreferences`) reads the visible, primary and focus ids that a layout publishes on `window.__conclaveGetMeetRoomTilingDebug`.

PR #326 moved tile placement and the hints of `GridLayout` into one result, `resolveMeetingStageLayout`. Its final review found two things on screen that the result did not cover:

- The floating self-view was positioned by CSS in a corner of the stage, outside the placement. With a 188 px rail it covered a pinned camera's Unpin control and the whole live share, and at 1024 x 245 it covered the Auto companion camera while that camera was still reported visible and primary.
- `MeetingAppLayout`, which hosts the shared browser and in-call apps, published nothing. With its rail hidden, the policy fell back to treating the first cameras as visible, so Data Saver kept downloading cameras nobody could see.

Both are the same gap: something decided what is on screen without telling the placement.

## Decision

A stage placement is the only source of what is on screen. Every layout that places tiles builds one, and publishing it is the only way to get the stage scaffolding.

1. **The placement measures the stage.** `resolveMeetingStageLayout` returns a rect for the main tile, the companion, every rail tile, the overflow tile and the compact pin. The sizes that CSS used to pick alone (the companion rail height, the compact pin) now come from these rects.
2. **The self-view is placed, not floated.** `placeStageOverlay` tries the requested corner, then the corner beside it, then the corner below or above it, then the opposite corner. A corner is clear when the self-view covers no part of a live share or compact pin, no tile's controls (the 140 x 48 px box at a tile's top right), and at most half of any other tile. The first clear corner wins.
3. **No clear corner means no overlay.** A floating self-view then takes a rail slot, but only a free one: it never replaces a camera or the overflow tile. Otherwise it is not shown. A minimized self-view that has no clear corner is not shown. The requested mode is kept, so the self-view returns when the stage has room.
4. **Hints come from the placement.** `visibleRemoteIds`, `primaryIds`, `hiddenIds` and the presentation flags are fields of the placement (`StageHints`). The tiled grid and the app stage have their own resolvers, `resolveTiledGridPlacement` and `resolveContentStagePlacement`, that return the same shape.
5. **Publishing is part of rendering a stage.** `usePublishStagePlacement` publishes a placement and returns it as a `PublishedStagePlacement`. The rail and split helpers in `stage-layout.ts` accept only that type, so a layout cannot render a stage rail from a placement it did not publish.
6. **Focus follows the published layout.** The publisher drops any focus id that is not placed, and the policy takes focus from the layout whenever a layout has published. A speaker whose camera is off the stage is parked in Data Saver like any other hidden camera.
7. **The app stage decides its rail in the placement.** The two viewport rules that used to hide its rail with CSS (apps below 64 rem, and short landscape phones) are inputs to `resolveContentStagePlacement`. Its audio no longer lives in the rail tiles, so a stage without a rail still plays everyone.
8. **A scrolling rail reports its window.** The app stage rail holds every participant and scrolls. Scroll position is state that a placement cannot derive, so the rail reports which of its tiles are inside its viewport (`useScrollWindow`) and the placement counts only those tiles as visible.

## Consequences

- The floating self-view can sit in a different corner from the one the user chose, and it is not shown over a share that fills the stage (Spotlight, or a stage too small for a rail).
- In the tiled grid a top corner is usually blocked by a tile's controls, so the self-view moves to the other top corner or to the bottom.
- The published metadata gains `stage.rects`, `selfView.rect` and `selfView.placedCorner`, which the Chrome matrix compares with the DOM.
- The webinar attendee stage does not publish. The SFU sends an attendee only the feed it shows, so it has no hidden camera to park.
- Two other scrollers still report every tile they render as visible: the overflow gallery under the stage, and the phone portrait grid. Both need the same window input as the app stage rail.
- Revisit if the tile controls move or grow: `tileControlsRect` must cover them.

## Alternatives considered

- **Guard each overlap in CSS:** rejected. It fixes the reported corners and keeps two owners of what is on screen.
- **Measure overlaps in the DOM at run time:** rejected. The download hints would depend on a measurement that lags the layout, and the rule could not be tested as a function.
- **Report a covered camera as hidden and leave the overlay where it is:** rejected. A camera that is half visible would be paused in Data Saver.
- **Give the app stage rail a capacity and an overflow tile like the meeting rail:** rejected. It changes how the app stage looks. Reporting the scroll window keeps the rail as it is.

## Code

- `apps/web/src/app/lib/stage-overlay.ts`: `placeStageOverlay`, `tileControlsRect`, `overlayClearsSurface`
- `apps/web/src/app/lib/meeting-stage-layout.ts`: `resolveMeetingStageLayout`, `resolveTiledGridPlacement`, `resolveContentStagePlacement`, `StageHints`
- `apps/web/src/app/hooks/usePublishStagePlacement.ts`: `usePublishStagePlacement`, `PublishedStagePlacement`
- `apps/web/src/app/hooks/useScrollWindow.ts`: `useScrollWindow`, `readScrollWindow`
- `apps/web/src/app/components/stage-layout.ts`: the scaffolding that takes a `PublishedStage`
- `apps/web/test/stage-placement.test.ts`: the placement rules across stage sizes, corners and scenarios
