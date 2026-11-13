# grok-bot-plugins

Public Grok Bot plugins, starting with **SkiHerd**.

**Hosted free by Tyler Jewell, bare minimum, no data kept, everything deleted after 24h.**

**Connect any agent: add MCP URL https://skiherd.jewell-labs.com/mcp, then say 'run the SkiHerd setup'.**

[SkiHerd plugin](./plugins/skiherd) · [Privacy note](https://skiherd.jewell-labs.com/privacy.html) · [Terms](https://skiherd.jewell-labs.com/terms.html)

Grok Bot first, then ChatGPT, Claude, or any MCP client can use that same URL. You do not need a Cloudflare account. A bot that only adds the MCP URL still gets the `healthcheck` and `setup` skills — they are packaged in the plugin and also served over MCP as prompts, as `skiherd://skills/healthcheck` and `skiherd://skills/setup` resources, and via the `get_skill` tool.

Always run `healthcheck` first. Do not create, join, or update a group until it returns `ok: true`. Then follow the `setup` skill. `GET https://skiherd.jewell-labs.com/health` returns the same health payload.

This project is not affiliated with Winter Park Resort. Trail and lift geometries are a bundled OpenStreetMap extract (© OpenStreetMap contributors, ODbL). Map tiles: OpenFreeMap.

## What Phase 1 does

- Create a group of up to 10 skiers, or join with an invite.
- Invite friends with an opaque, expiring, capped invite token. A person's map link uses a `#t=` fragment (never a query string); the page strips it after load.
- Post location heartbeats (one point or a batch).
- See everyone on a MapLibre map with live WebSocket updates.
- Ask MCP tools for the map, group stats, runs not hit, and a suggested new route.
- A member can leave; any current member can delete the group now. Otherwise the group self-deletes 24 hours after creation.

Each group lives in its own SQLite-backed Cloudflare Durable Object. Twenty-four hours after the group is created, the object deletes all of its storage. Nothing is kept.

Phase 1 authentication is unguessable group and member tokens (no email, no phone). The OAuth upgrade path is documented in `src/mcp.ts`.

## Repo layout

```
.cursor-plugin/marketplace.json   # multi-plugin marketplace
plugins/skiherd/                  # plugin manifest, healthcheck + setup skills, MCP config
src/                              # Worker + SkiGroup Durable Object
public/                           # map UI, privacy, terms
data/                             # Winter Park OSM extract + simulated day
test/                             # vitest + @cloudflare/vitest-plugin
scripts/embed-skills.mjs          # keeps served skill text in sync with the repo files
```

The Worker is named `skiherd-groups` so it does not collide with the separate `skiherd` app. Production is `https://skiherd.jewell-labs.com` on Tyler's personal Cloudflare account.

## Develop

```sh
npm install
npm test
npm run dev
```

`npm run check` regenerates Worker types and fails if the embedded skills drift from `plugins/skiherd/skills`. After editing a skill, run `npm run embed-skills`.

Do not deploy, and do not change DNS, unless Tyler has approved that deploy. Production uses the `personal` Wrangler profile and the `cf` CLI from `~/cf`.

## License

MIT. See [LICENSE](./LICENSE).
