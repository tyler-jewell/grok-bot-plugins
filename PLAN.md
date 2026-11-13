# SkiHerd Phase 1 plan

Research notes also live in the working copy at `/workspace/skiherd-plugin/PLAN.md` (not in this repo). This file records the decisions this repo implements.

## Go-to-market

Tyler decided (4:28–4:33 PM America/Chicago, 13 November 2026) to host SkiHerd himself so anyone can use it without a Cloudflare account.

### Offer

- A **free** public plugin anyone can use. **Grok Bot first**, then ChatGPT, Claude, or any MCP client via the same MCP URL (`https://skiherd.jewell-labs.com/mcp`).
- Plugin README and marketplace listing state: **hosted free by Tyler Jewell, bare minimum, no data kept, everything deleted after 24h**.
- Tyler hosts the zone on **jewell-labs.com** (already exists) on his **personal** Cloudflare account (Wrangler profile `personal`, `cf` CLI from `~/cf`). Users need no Cloudflare account.
- Architecture: one SQLite-backed Durable Object per group; the DO holds the group's data, serves the website (map UI) and MCP tools; each DO self-deletes all storage via alarm 24 hours after creation. No data is kept.

### Later (same backend)

- **"Use app on your phone"** installs a PWA from the same site. Same UI/UX, plus live streaming. The backend does not change.
- After the PWA exists, offer a **paid tier**: subscriptions, longer storage, AI features, and other extras. The free 24-hour group remains the default.

### Go-to-market risks

- **Abuse and cost on a free public endpoint.** Anyone can hit `/mcp` and `/api/groups`. Mitigate with application rate limits, a group cap of 10, per-IP and per-group limits, and Turnstile on group creation (keys not provisioned in this PR). Watch Workers Paid usage. If abuse grows, tighten limits or require a sign-in before going paid.
- **Privacy, consent, and children.** Location is sensitive. Request location once; reuse a known profile name; no covert tracking. Not directed at children under 13. Do not post heartbeats for someone who did not consent. `/privacy.html` and `/terms.html` ship in Phase 1.
- **Trademark of "Winter Park".** Geographic reference only. User-facing surfaces state the project is not affiliated with Winter Park Resort (or Alterra). No resort logos or wordmarks.
- **Terms of use and privacy policy.** Required before launch; included as static pages.
- **Cloudflare logs retention.** Durable Object `deleteAll` removes product data. Cloudflare may still retain operational request logs per its policies. The privacy note says this. Application logs must not include raw coordinates or raw tokens.
- **Install path is still incomplete.** In-chat "install plugin from this repo URL" is not a documented Grok Bot feature. Marketplace submission and a pasted MCP URL are the reliable paths.

## Closed decisions

- DO-per-group, 24h self-delete, hosted on Tyler's personal Cloudflare account.
- Free public plugin GTM as above.
- Public repo `tyler-jewell/grok-bot-plugins`. Worker name `skiherd-groups`.
- Phase 1 auth: unguessable tokens, no PII; document the OAuth upgrade path.
- MIT license.
- No deploy and no DNS changes in the first PR.

## Phase 1 acceptance (build)

- Monorepo with `.cursor-plugin/marketplace.json` and `plugins/skiherd` (manifest, onboarding skill, MCP config pointing at the placeholder URL).
- Worker + map UI + MCP tools listed in the README.
- DO alarm deletes all storage 24h after creation, covered by a test.
- Simulated Winter Park day replayed through `post_heartbeat`, with assertions on `runs_not_hit` and stats.
- CI with SHA-pinned actions.
- Do not deploy; open a PR and stop.
