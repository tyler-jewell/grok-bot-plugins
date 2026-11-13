---
name: setup
description: Walk a human through SkiHerd from a healthy MCP connection: consent, location once, create or join a group, first heartbeat, map link, and a 5-minute heartbeat cadence. Use after healthcheck passes.
---

# SkiHerd setup

Use this after the `healthcheck` skill (and the `healthcheck` tool) has passed in this session. If it has not, run healthcheck first and stop on failure.

This flow is for any MCP client. Grok Bot is first, but the same steps work in Claude, ChatGPT, or any other agent that can call these tools. You do not need a Cloudflare account.

SkiHerd is hosted free by Tyler Jewell, bare minimum, no data kept, everything in a group deleted 24 hours after the group is created. It is not affiliated with Winter Park Resort.

## Stop and tell the human

Stop and tell the human, clearly, when any of these happen. Do not invent a workaround that hides the failure.

- Healthcheck is not `ok`.
- The human does not consent to sharing a display name and location with the group for 24 hours.
- You cannot get a location (no device location tool, and the human does not share one).
- A tool returns `unauthorized`, `gone`, `not_found`, `full`, or `rate limited`.
- The group already has 10 members.
- `group_map` after the first heartbeat does not show this human.
- You are asked to track someone who did not consent, or to locate a child. Refuse.

## 1. Confirm healthcheck

If you have not called `healthcheck` in this session, or the last result was not `ok`, run the healthcheck skill now. Do not continue until it passes.

## 2. Identify the human

Reuse a known display name from the agent's profile or memory. Ask, via an in-chat form if you have one, only for fields you do not already know. Phase 1 only needs a first name or nickname — no email, no phone, no account.

If they are joining a friend's group, you also need the invite link or the group token plus invite token. Ask only if they have not already given it.

## 3. Explain privacy and get consent

Say this in your own words, then wait for a clear yes:

- Hosted free by Tyler Jewell. Bare minimum. No data is kept after the group ends.
- The group stores a display name, unguessable tokens, and the locations that get posted.
- Everything in the group is deleted automatically 24 hours after the group is created. Any current member can also delete the group now; a member can leave.
- Do not share member tokens. Share the map link or an invite link instead.
- This is not for tracking anyone without their consent, and it is not directed at children under 13.

If they say no, stop. Do not create or join a group.

## 4. Request device location once

Request location **once** for this group.

- If you have a device location tool (for example Grok Bot location), use it now, with the human's permission, and reuse that reading for the first heartbeat. Do not start silent background tracking.
- If you do not have a location tool, ask the human to share their current coordinates (or a pin). Do not guess a location.

If you cannot get a location, stop and tell the human you cannot place them on the map yet.

## 5. Create or join a group

- To start a group: call `create_group` with the display name. Save the returned `group_token`, `member_token`, `member_map_url`, `host_url`, and `expires_at`. Do not paste the member token into the chat unless the human asks for it.
- To join: call `join_group` with the group token, invite token, and display name. Save the member token and `member_map_url` the same way.
- Send this human their `member_map_url` (it uses a `#t=` fragment). The map page reads the token, stores it in session storage, and strips the fragment so it is not sent to the server or left in the address bar. Never put a member token in a query string, and never share `member_map_url` as a group-wide link.
- If the human is the host and wants friends on the map, call `create_invite` and share the **invite URL** or the token-free `host_url`, not the member token or `member_map_url`.

Cap is 10 people. If the tool says the group is full or the invite is expired or already used, stop and tell the human.

## 6. Post the first heartbeat

Call `post_heartbeat` with the group token, member token, and one point (timestamp, lat, lon; altitude and activity if you have them). Prefer a batch of on-device fixes over a single coarse point when you have a track.

## 7. Share the map link and verify

Send the human their `member_map_url` so they can open the live map. Then call `group_map` and confirm this human appears with a fix. If they do not, stop and tell the human that the first heartbeat did not show up.

## 8. Offer a 5-minute heartbeat cadence

- **Grok Bot:** offer to set a routine that runs every 5 minutes, reads location (reusing the permission already granted), and calls `post_heartbeat`. The platform minimum interval is 5 minutes. Be clear that 5-minute snapshots undercount ski stats; a denser on-device track uploaded in batches is better when available. Do not start the routine unless the human agrees.
- **Other agents (Claude, ChatGPT, and anyone else):** explain that they should post a heartbeat about every 5 minutes while the human is skiing — using whatever scheduler, plugin, or manual prompt they have — and that the backend is the same. Do not pretend you can install a Grok Bot routine in another product.

Remind them the group, including heartbeats, is deleted 24 hours after creation (or sooner if any current member deletes it). A member who wants out can use `leave_group`. Any current member can use `delete_group`; the response records who deleted the group.

## Tools you may use after setup

`create_invite`, `post_heartbeat`, `group_map`, `group_stats`, `runs_not_hit`, `suggest_new_route`, `leave_group`, `delete_group`. If anything fails, run `healthcheck` again. If healthcheck fails, stop and tell the human.
