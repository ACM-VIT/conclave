# Meets Client

This UI is framework-agnostic in behavior but expects you to provide SFU integration.

Required props for `MeetsClient` in `src/app/clients/meets-client.tsx`:
- `getJoinInfo(roomId, sessionId)`: return `{ token, sfuUrl }` for socket auth.
- `getRooms()`: return `RoomInfo[]` for the admin room list (optional).
- `getRoomsForRedirect(roomId)`: optional room list for admin redirects (receives current room id).
- `reactionAssets`: optional array of reaction asset filenames (without `/reactions/`).
- `user`, `isAdmin`: current user metadata.

For Next.js, avoid passing raw functions from a Server Component. Use a client wrapper like `src/app/clients/meets-client-page.tsx` to provide the functions.

## Integration notes

- Provide `getJoinInfo` in `src/app/clients/meets-client-page.tsx` (client wrapper) or wire your own wrapper in your app shell.
- Optionally provide `getRooms` and `getRoomsForRedirect` to populate the admin room list and redirect modal.
- Reaction assets are served from `public/reactions` and passed via `reactionAssets` (filenames only, without `/reactions/`).
