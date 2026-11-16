# grok-bot-plugins

Public Grok Bot plugins, starting with **SkiHerd**.

**Hosted free by Tyler Jewell, bare minimum. Group data is deleted after 24h. Only aggregate counters are kept, for 35 days.**

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

Each group lives in its own SQLite-backed Cloudflare Durable Object. Twenty-four hours after the group is created, the object deletes all of its storage. SkiHerd keeps aggregate daily counters for 35 days: groups created, groups deleted by a member, groups expired by the alarm, rate-limit rejections by limiter name, and request errors by status class. Those counters are integers only. They hold no tokens, group ids, names, coordinates, IP addresses, or user agents. `GET /counters` returns the aggregates.

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
| `post_heartbeat` | Post one location or a batch for the authenticated member. | `group_token`, `member_token`, `heartbeats` (1-500 items per call; each has `ts`, `lat`, `lon`, plus optional `alt_m`, `accuracy_m`, `speed_mps`, `heading_deg`, `battery_pct`, `activity`, `place`, `lift_or_trail`, `difficulty`) |
| `group_map` | Latest position of each member. | `group_token`, `member_token` |
| `group_stats` | Per-member descent, distance, top speed, run count, and time in run/lift/lodge. | `group_token`, `member_token` |
| `runs_not_hit` | Winter Park downhill trails (bundled OSM extract) that no member has a run heartbeat on. | `group_token`, `member_token` |
| `suggest_new_route` | Suggest a nearby trail the group has not hit, plus a lift that finishes close to it. | `group_token`, `member_token` |
| `leave_group` | Remove the member and their heartbeats; the last member leaving deletes the group. | `group_token`, `member_token` |
| `delete_group` | Delete the group now and wipe its storage. Any current member can do this. | `group_token`, `member_token` |

## Rate limits and caps

Per client IP (from `CF-Connecting-IP`, normalised; `X-Forwarded-For` is ignored when it is present), per hour. HTTP and MCP share one bucket per action. Past the limit HTTP returns 429 with `retry-after`, and MCP returns an `isError` tool result with `error: "rate_limited"`. Override any default with the Worker var shown (invalid or below 1 falls back to the default). The defaults are declared at the top level of `wrangler.jsonc` and again under `env.staging`, because Wrangler does not inherit `vars`.

| Action | Default | Var |
| --- | --- | --- |
| create group (HTTP and MCP) | 5 | `CREATE_GROUP_PER_IP_PER_HOUR` |
| join (HTTP and MCP) | 20 | `JOIN_PER_IP_PER_HOUR` |
| create invite (HTTP and MCP) | 20 | `INVITE_PER_IP_PER_HOUR` |
| post heartbeats (HTTP and MCP) | 120 | `HEARTBEAT_PER_IP_PER_HOUR` |

Each group stores at most `MAX_HEARTBEATS_PER_GROUP` heartbeat rows (default 20000, about 2000 fixes for each of 10 members over the 24-hour life). Past the cap new points are dropped, not stored; the response reports `dropped_over_cap`. Earlier points are kept.

The landing page (`POST /api/groups`) checks a Cloudflare Turnstile token when the Worker secret `TURNSTILE_SECRET` is set. That secret is not a var and is not in this repo. MCP `create_group` is not challenged; it stays on the per-IP rate limit, because agents have no browser. With no secret configured, HTTP creation skips the check and `/health` reports `turnstile: disabled`. The public site key, when set as `TURNSTILE_SITE_KEY`, is written into the landing page only.

## HTTP API

Auth `Bearer` means `Authorization: Bearer <member token>`. Member tokens are rejected in query strings. `:id` is the group token.

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/health` | none (returns 503 when unhealthy) |
| ANY | `/mcp` and `/mcp/*` | none (tools take tokens as arguments) |
| POST | `/api/groups` | none (rate limited per IP). When `TURNSTILE_SECRET` is set, the body must include a Turnstile token. MCP `create_group` is not challenged. |
| GET | `/api/groups/:id` | Bearer |
| DELETE | `/api/groups/:id` | Bearer |
| POST | `/api/groups/:id/invites` | Bearer (rate limited) |
| POST | `/api/groups/:id/join` | none (invite token in body; rate limited) |
| POST | `/api/groups/:id/heartbeats` | Bearer (rate limited) |
| GET | `/api/groups/:id/map` | Bearer |
| GET | `/api/groups/:id/stats` | Bearer |
| GET | `/api/groups/:id/runs-not-hit` | Bearer |
| GET | `/api/groups/:id/suggest` | Bearer |
| POST or DELETE | `/api/groups/:id/leave` | Bearer |
| GET | `/g/:id` | none (serves the map page; the member token stays in the URL fragment) |
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

The Worker is named `skiherd-groups` so it does not collide with the separate `skiherd` app. The committed Wrangler config does not pin a production hostname.

## Environments

`wrangler.jsonc` has no top-level route and no production `PUBLIC_BASE_URL`. `workers_dev` is false, so a custom domain is the only entry point.

- **Staging** (`wrangler deploy --env staging`): Worker `skiherd-groups-staging`, custom domain `skiherd-groups.jewell-labs.com`, `PUBLIC_BASE_URL` `https://skiherd-groups.jewell-labs.com`. `env.staging` declares `vars`, the `GROUP` -> `SkiGroup` and `COUNTERS` -> `DailyCounters` bindings, and migrations again. Wrangler does not inherit `vars` or `durable_objects` into an environment. `assets` and `migrations` do inherit; migrations are repeated so staging cannot silently drift.
- **Production:** the hostname comes from the repository variable the owner sets. It is not stored in this repo. `node scripts/render-production-config.mjs --hostname "$PRODUCTION_HOSTNAME"` writes a config whose only route is that hostname with `custom_domain: true`, and sets `PUBLIC_BASE_URL` to `https://` plus the hostname. The script exits non-zero when the hostname is empty, whitespace, a URL with a scheme, a path, a wildcard, a port, or the staging hostname.

Do not deploy, and do not change DNS, unless Tyler has approved that deploy. Production uses the `personal` Wrangler profile and the `cf` CLI from `~/cf`.

## Develop

```sh
npm ci
npm test
npm run dev
```

`npm run check` regenerates Worker types and fails if the embedded skills drift from `plugins/skiherd/skills`. After editing a skill, run `npm run embed-skills`.

Do not deploy, and do not change DNS, unless Tyler has approved that deploy. Production uses the `personal` Wrangler profile and the `cf` CLI from `~/cf`.

## Release lifecycle

PR checks, then merge to `main`, then a staging candidate, then an explicit promote to production.

1. **Pull request:** the `check` workflow (job `test`) must pass before merge.
2. **Staging candidate and deploy:** when `check` succeeds on a push to `main`, the `staging` workflow builds a credential-free candidate artifact `candidate-<sha>`, then a `deploy` job on the `staging` environment runs `wrangler deploy --env staging`. That job refuses before wrangler when `CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_API_TOKEN` is missing. After a real deploy it checks `https://skiherd-groups.jewell-labs.com/health` for this sha and uploads artifact `staging-deploy-<sha>` with the sha, version id, and migration tag.
3. **Promote:** run the `release` workflow manually (Actions tab, "Run workflow" on `main`) with `confirm` set to `promote-staging`. It refuses unless the sha is the current `main` head and has a non-expired `candidate-<sha>` artifact. A candidate is identified by that artifact, named for the commit, not by a staging run: for `workflow_run`-triggered runs GitHub reports the default branch head as the run's `head_sha`, which can be a different commit than the one built. The head of `main` is re-checked right before the tag is created, so a newer merge makes an older candidate stale. On success it creates the tag `prod/YYYY.MM.DD+N` (UTC date, N counts up from 1 per day) and a GitHub Release with generated notes. Promoting a sha that is already released exits cleanly and creates nothing.
4. **Production deploy:** the `deploy` job needs that release, uses the `production` environment, and refuses when `PRODUCTION_HOSTNAME` or `CLOUDFLARE_ACCOUNT_ID` is empty, when the API token is missing, when issue #18 is open, or when `staging-deploy-<sha>` is missing or its migration tag is not the tag this commit would apply. Migrations must stay append-only versus `scripts/applied-migrations.json`. It then renders the production config from the hostname variable and checks `/health` on that host. The hostname value is not stored in this repo.

The tag and release logic lives in `scripts/lib/release.mjs` and is covered by `test/next-tag.test.ts`.

## License

MIT. See [LICENSE](./LICENSE).
