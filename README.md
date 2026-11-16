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

## MCP tools

The MCP endpoint is `/mcp`. Tools that act on a group take `group_token` and `member_token` (Phase 1 bearer tokens) unless noted.

| Tool | Description | Inputs |
| --- | --- | --- |
| `healthcheck` | Check the Worker, Durable Objects, storage, alarms, map site, OSM data, and rate limiter. Call first every session. | none |
| `get_skill` | Return the `healthcheck` or `setup` skill as markdown. | `name` (`healthcheck` or `setup`) |
| `create_group` | Create a group; returns a group token, host member token, and map URL. Rate limited per IP. | `host_name` (1-40 chars) |
| `create_invite` | Create an opaque, expiring invite token (default single use, one hour). | `group_token`, `member_token`, `ttl_ms` (optional), `max_uses` (optional, max 10) |
| `join_group` | Join with an invite token and a display name; returns a member token. | `group_token`, `invite_token`, `display_name` (1-40 chars) |
| `post_heartbeat` | Post one location or a batch for the authenticated member. | `group_token`, `member_token`, `heartbeats` (non-empty array of `ts`, `lat`, `lon`, plus optional `alt_m`, `accuracy_m`, `speed_mps`, `heading_deg`, `battery_pct`, `activity`, `place`, `lift_or_trail`, `difficulty`) |
| `group_map` | Latest position of each member. | `group_token`, `member_token` |
| `group_stats` | Per-member descent, distance, top speed, run count, and time in run/lift/lodge. | `group_token`, `member_token` |
| `runs_not_hit` | Winter Park downhill trails (bundled OSM extract) that no member has a run heartbeat on. | `group_token`, `member_token` |
| `suggest_new_route` | Suggest a nearby trail the group has not hit, plus a lift that finishes close to it. | `group_token`, `member_token` |
| `leave_group` | Remove the member and their heartbeats; the last member leaving deletes the group. | `group_token`, `member_token` |
| `delete_group` | Delete the group now and wipe its storage. Any current member can do this. | `group_token`, `member_token` |

## HTTP API

Auth `Bearer` means `Authorization: Bearer <member token>`. Member tokens are rejected in query strings. `:id` is the group token.

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/health` | none |
| ANY | `/mcp` | none (tools take tokens as arguments) |
| POST | `/api/groups` | none (rate limited per IP) |
| GET | `/api/groups/:id` | Bearer |
| DELETE | `/api/groups/:id` | Bearer |
| POST | `/api/groups/:id/invites` | Bearer |
| POST | `/api/groups/:id/join` | none (invite token in body; rate limited) |
| POST | `/api/groups/:id/heartbeats` | Bearer (rate limited) |
| GET | `/api/groups/:id/map` | Bearer |
| GET | `/api/groups/:id/stats` | Bearer |
| GET | `/api/groups/:id/runs-not-hit` | Bearer |
| GET | `/api/groups/:id/suggest` | Bearer |
| POST or DELETE | `/api/groups/:id/leave` | Bearer |
| GET | `/g/:id/ws` | WebSocket upgrade; member token sent in the first message |

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
npm ci
npm test
npm run dev
```

`npm run check` regenerates Worker types and fails if the embedded skills drift from `plugins/skiherd/skills`. After editing a skill, run `npm run embed-skills`.

Do not deploy, and do not change DNS, unless Tyler has approved that deploy. Production uses the `personal` Wrangler profile and the `cf` CLI from `~/cf`.

## License

MIT. See [LICENSE](./LICENSE).
