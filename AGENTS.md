# grok-bot-plugins

Public Grok Bot plugins and the SkiHerd group-map Worker. Grok Bot does this work directly with Tyler. Open every change as a pull request. Do not merge to `main` unless Tyler asked you to. Do not deploy, and do not touch DNS or Cloudflare resources, unless Tyler explicitly approved that deploy.

## Pull requests and issues

- Link every PR to an issue.
- Record design choices as `type:decision` issues. Never delete issues; they are repo history.
- Keep discussion in the PR and issues, not in chat-only decisions.

## Hosting

- Production, when Tyler approves a deploy, is Tyler's **personal** Cloudflare account, Wrangler profile `personal`, `cf` CLI from `~/cf`.
- Worker name is `skiherd-groups` (not `skiherd`, which is a different app on the same account).
- Hostname is `skiherd.jewell-labs.com`. Keep the `custom_domain` route for that hostname in `wrangler.jsonc` so deploys do not drop it. Do not put `account_id` in `wrangler.jsonc`.
- Users of the plugin do not need a Cloudflare account.

## Safety

- Never print secrets, tokens, account IDs, or API keys.
- Do not log raw coordinates or raw member/invite/group tokens.
- Phase 1 auth is unguessable tokens stored as SHA-256 hashes. No PII.
- Do not add wrangler Rate Limit bindings or Turnstile keys that would provision account resources on deploy until Tyler approves those IDs.

## Product constraints

- One SQLite Durable Object per group. The DO holds the group's data, serves the map, and backs MCP tools.
- A DO alarm calls `deleteAll` 24 hours after creation. No data is kept.
- Cap of 10 members. Rate-limit group creation and heartbeats in application code.
- Call the product SkiHerd, never Shredpath.
- "Winter Park" is a geographic reference only. The UI and README must say the project is not affiliated with Winter Park Resort.
- Plugin listing copy: hosted free by Tyler Jewell, bare minimum, no data kept, everything deleted after 24h.

## Engineering

- TypeScript Worker, Wrangler, `compatibility_date` current as of the change.
- Tests: `vitest` plus `@cloudflare/vitest-plugin` (the current Workers vitest integration; older docs said `@cloudflare/vitest-pool-workers`).
- CI actions must be SHA-pinned.
- For HTML/CSS/JS, follow `npx -y modern-web-guidance@1.0.0`.
- `npm run check` and `npm test` must pass before a PR is ready.
- Exactly two skills, source of truth in `plugins/skiherd/skills/{healthcheck,setup}/SKILL.md`. The Worker serves the same text as MCP prompts, `skiherd://skills/...` resources, and the `get_skill` tool. `scripts/embed-skills.mjs --check` (via `npm run check`) fails if `src/skills.generated.ts` drifts from those files.
- Any agent that only adds the MCP URL must still be able to run healthcheck, then follow the setup skill, before acting on a group.
