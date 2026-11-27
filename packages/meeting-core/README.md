# @conclave/meeting-core

Shared meeting domain logic for `apps/web` and mirrored native behavior.

## What belongs here

- Data contracts shared by the web client and SFU (`types.ts`, `sfu-types.ts`)
- The guest claims of a join token, as one schema that the join route signs from and the SFU parses with (`guest-join-claims.ts`)
- Pure meeting domain reducers and command parsing
- Configurable media encoding helpers

## What should stay in app code

- Platform-specific UI and hooks
- Transport wiring and side effects (browser APIs, native APIs)
- Environment-specific constants

## Why this exists

The web client and SFU were duplicating core domain files. This package keeps
those TypeScript primitives in one place. The active Skip client mirrors the
small pure algorithms it needs in Swift and verifies them with native tests.

## Grid layout with mixed tile aspects

`computeGridLayout` takes an optional `tileAspects` list: the width over height
of each tile on the page, in order. Missing or invalid entries count as
`targetAspect`. When every tile matches `targetAspect`, the page is a uniform
grid. Otherwise it packs into justified rows that line up on one shared width.

- Every tile on the page has the same height. A tile's natural width is that
  height times its aspect.
- A single row keeps its tiles at their natural whole pixel widths.
- With two or more rows, the rows share one width. A tile may stretch to 1.25
  times its natural width or shrink to its natural width divided by 1.25.
  Portrait tiles take half the share of a row's resize, and stretching prefers
  to stop a portrait tile at 4:5.
- The shared width starts from the widest row and is then limited to what
  every full row can reach inside those caps. It can be larger or smaller than
  a row's natural width, so alignment can shrink the widest row. For example,
  with `maxCols: 1`, `gap: 12` and aspects `[1.5, 1]` in a 400 by 212
  container, the rows are 100 px tall with natural widths 150 and 100, and
  both come out 125 px wide.
- When the rows cannot all meet, the shared width minimises one convex cost:
  1 per px away from the preferred width above, 4 per px outside each shorter
  row's range, and, weighted above both, the largest miss among the full rows,
  so full rows that cannot quite meet share the miss. A shorter row can pull
  the shared width up toward the widest full row, but never below the smaller
  of the preferred width and the widest full row's natural width.
- A shorter last row that cannot reach the shared width takes its nearest
  width inside its caps. If it misses by more than 8 px it eases back toward
  its natural width, 3 px for every px past that, so a lone last tile sits at
  its own width.
