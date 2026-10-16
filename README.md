# Remote Party Finder Reborn Web

Public web and edge relay for Remote Party Finder Reborn.

## Environment

- `PORT`: HTTP port. Defaults to `3000`.
- `ORIGIN_BASE_URL`: Raspberry Pi origin server URL. Prefer a tunnel URL over a raw IP.
- `ORIGIN_TIMEOUT_MS`: relay timeout in milliseconds. Defaults to `10000`.
- `LISTINGS_REVISION_WEBHOOK_SECRET`: shared secret for Pi origin revision webhooks.

The browser talks only to this web/edge app. API and ingest traffic is relayed to the private origin. Listing live updates use a local browser WebSocket on this web app, fed by authenticated Pi origin revision webhooks.

## Job icon assets

`public/assets/job-icons.svg` is a static sprite generated from Gamer Escape's `Set 10 (Large)` job-icon column. After reviewing a source update, regenerate it with `npm run sync:job-icons`; the command needs `curl` and internet access. Beastmaster currently has no image in that column, so the generator adds a labeled placeholder for `BST` and fails if another job icon is missing. The browser serves only the checked-in SVG and does not request icons from Gamer Escape at runtime.
