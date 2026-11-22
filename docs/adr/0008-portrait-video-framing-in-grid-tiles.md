# 0008. Portrait video framing in grid tiles

- Status: Accepted
- Date: 2026-11-22

## Context

A portrait phone camera shown in a landscape tile loses about two thirds of its height to a full `cover` crop. Cameras send only a few shapes, and simulcast layers of one camera can miss that shape by a pixel of rounding, which would reshape a tile on every layer switch.

## Decision

- Portrait video in a landscape tile is zoomed only far enough to keep `PORTRAIT_VISIBLE_HEIGHT` (60 percent) of its height, over a blurred copy of the same video.
- A camera's aspect snaps to the nearest known shape of the same orientation (`PORTRAIT_ASPECTS` or `LANDSCAPE_ASPECTS`). The previous shape is kept unless a frame is clearly nearer another one, so a layer switch never reshapes a tile.
- The tile's paint containment makes it a stacking context, so `PORTRAIT_BACKDROP_STYLE` uses a negative z-index to sit under the real video and above the tile.

## Consequences

- Portrait callers keep their face and most of the frame in a landscape grid.
- Removing the tile's paint containment would change the stacking order of the blurred backdrop.

## Alternatives considered

- **Full `cover` crop:** rejected because it loses most of a portrait frame.
- **Letterboxing with `contain`:** rejected because the video becomes a thin strip in a wide tile.

## Code

- `apps/web/src/app/lib/tile-video-framing.ts`: `PORTRAIT_VISIBLE_HEIGHT`, `PORTRAIT_ASPECTS`, `LANDSCAPE_ASPECTS`, `PORTRAIT_BACKDROP_STYLE`
