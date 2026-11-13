---
name: healthcheck
description: Verify the SkiHerd MCP server and its backend are up before creating, joining, or updating a group. Run this first, every session, and whenever something fails.
---

# SkiHerd healthcheck

Run this before you do anything else with SkiHerd. Do not create a group, join a group, post a heartbeat, or share a map link until healthcheck passes.

## What to do

1. Call the `healthcheck` tool (no arguments). If you cannot call tools yet, say so and stop.
2. Read the structured result. Every component has `ok: true` or `ok: false`. `ok` at the top level must be true before you continue.
3. If `ok` is true, tell the human briefly that SkiHerd is up, then follow the `setup` skill (prompt `setup`, resource `skiherd://skills/setup`, or `get_skill` with `name=setup`).
4. If `ok` is false, **stop**. Do not retry group operations in a loop. Read each failed component's `advice`, tell the human what is down and what was suggested, and wait for them.

## What the result means

- `worker`: the deployed Worker name, version, and git commit. Failure means this MCP is not the SkiHerd Worker you expect.
- `durable_object`: an ephemeral probe object (not a user group) could be reached. Failure means group storage is unavailable.
- `storage`: a write and a read succeeded on that probe, then the probe was wiped. No user data is kept.
- `alarm`: scheduling the 24-hour self-delete alarm works.
- `map_site`: the map HTML can be served.
- `osm_data`: the bundled Winter Park lift and trail extract is loaded. This project is not affiliated with Winter Park Resort.
- `rate_limiter`: the application rate limiter can record a check. The result also reports the configured caps.
- `server_time`: the Worker's current time, as ISO-8601.

`GET https://skiherd.jewell-labs.com/health` returns the same payload.

## Rules

- Never skip this because a previous session was healthy.
- Never create a real group just to see if the server is up. Use this tool.
- If the tool itself errors, treat that as a failed healthcheck and tell the human.
