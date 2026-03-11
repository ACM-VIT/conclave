# Conclave Web

Development
- Install deps: `pnpm install`
- Start dev server: `pnpm --filter conclave-web dev`

Integration notes
- Provide `getJoinInfo` in `src/app/meets-client-page.tsx` (client wrapper) or wire your own wrapper.
- Optionally provide `getRooms` and `getRoomsForRedirect` to populate host room lists.
- Reaction assets are served from `public/reactions` and passed via `reactionAssets`.
- Set `NEXT_PUBLIC_SFU_CLIENT_ID` to tag requests with `x-sfu-client` so the SFU can apply per-client policies.

Avatar upload (pre-join)
- Configure Cloudinary for signed uploads in your web env:
	- `CLOUDINARY_CLOUD_NAME`
	- `CLOUDINARY_API_KEY`
	- `CLOUDINARY_API_SECRET`
	- optional: `CLOUDINARY_AVATAR_FOLDER` (default: `conclave/avatars`)
