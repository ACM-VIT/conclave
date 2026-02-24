# Meets Client

This UI is framework-agnostic in behavior but expects you to provide SFU integration.

Required props for `MeetsClient` in `src/app/meets-client.tsx`:
- `getJoinInfo(roomId, sessionId, options?)`: return `{ token, sfuUrl, iceServers? }` for socket auth. `options` may include `{ user, isHost }`.
- `getRooms()`: return `RoomInfo[]` for the host room list (optional).
- `getRoomsForRedirect(roomId)`: optional room list for host redirects (receives current room id).
- `reactionAssets`: optional array of reaction asset filenames (without `/reactions/`).
- `user`, `isAdmin`: current user metadata (used as host flag).

For Next.js, avoid passing raw functions from a Server Component. Use a client wrapper like `src/app/meets-client-page.tsx` to provide the functions.

## Integration notes

- Provide `getJoinInfo` in `src/app/meets-client-page.tsx` (client wrapper) or wire your own wrapper in your app shell.
- Optionally provide `getRooms` and `getRoomsForRedirect` to populate the host room list and redirect modal.
- Reaction assets are served from `public/reactions` and passed via `reactionAssets` (filenames only, without `/reactions/`).
- Set `NEXT_PUBLIC_SFU_CLIENT_ID` to tag requests with `x-sfu-client` so the SFU can apply per-client policies.
