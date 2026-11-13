# grok-bot-plugins

Public Grok Bot plugins, starting with **SkiHerd**.

**Hosted free by Tyler Jewell, bare minimum, no data kept, everything deleted after 24h.**

[SkiHerd plugin](./plugins/skiherd) · [Privacy note](https://skiherd.jewell-labs.com/privacy.html) · [Terms](https://skiherd.jewell-labs.com/terms.html)

The MCP URL (not deployed yet) is:

`https://skiherd.jewell-labs.com/mcp`

Grok Bot first, then ChatGPT, Claude, or any MCP client can use that same URL. You do not need a Cloudflare account.

This project is not affiliated with Winter Park Resort. Trail and lift geometries are a bundled OpenStreetMap extract (© OpenStreetMap contributors, ODbL). Map tiles: OpenFreeMap.

## What Phase 1 does

- Create a group of up to 10 skiers.
- Invite friends with an opaque, expiring, capped invite token.
- Post location heartbeats (one point or a batch).
- See everyone on a MapLibre map with live WebSocket updates.
- Ask MCP tools for the map, group stats, runs not hit, and a suggested new route.

Each group lives in its own SQLite-backed Cloudflare Durable Object. Twenty-four hours after the group is created, the object deletes all of its storage. Nothing is kept.

Phase 1 authentication is unguessable group and member tokens (no email, no phone). The OAuth upgrade path is documented in `src/mcp.ts`.

## Repo layout

```
.cursor-plugin/marketplace.json   # multi-plugin marketplace
plugins/skiherd/                  # plugin manifest, onboarding skill, MCP config
src/                              # Worker + SkiGroup Durable Object
public/                           # map UI, privacy, terms
data/                             # Winter Park OSM extract + simulated day
test/                             # vitest + @cloudflare/vitest-plugin
```

The Worker is named `skiherd-groups` so it does not collide with the separate `skiherd` app.

## Develop

```sh
npm install
npm test
npm run dev
```

Do not deploy, and do not attach a custom domain, unless Tyler has approved that deploy. Production, when it exists, uses the `personal` Wrangler profile and the `cf` CLI from `~/cf`.

## License

MIT. See [LICENSE](./LICENSE).
