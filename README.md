# Remote Party Finder Reborn Web

Public web and edge relay for Remote Party Finder Reborn.

## Environment

- `PORT`: HTTP port. Defaults to `3000`.
- `ORIGIN_BASE_URL`: Raspberry Pi origin server URL. Prefer a tunnel URL over a raw IP.
- `ORIGIN_TIMEOUT_MS`: relay timeout in milliseconds. Defaults to `10000`.
- `LISTINGS_REVISION_WEBHOOK_SECRET`: shared secret for Pi origin revision webhooks.

The browser talks only to this web/edge app. API and ingest traffic is relayed to the private origin. Listing live updates use a local browser WebSocket on this web app, fed by authenticated Pi origin revision webhooks.
