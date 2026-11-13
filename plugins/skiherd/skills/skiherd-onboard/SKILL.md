---
name: skiherd-onboard
description: Install and set up the SkiHerd group ski map plugin. Use when the user installs SkiHerd, wants a group map, an invite, or to start posting location heartbeats.
---

# SkiHerd onboarding

SkiHerd is a free public plugin. Hosted free by Tyler Jewell, bare minimum, no data kept, everything deleted after 24h. The same MCP URL works in Grok Bot first, then ChatGPT, Claude, or any MCP client.

The hosted MCP is `https://skiherd.jewell-labs.com/mcp` (placeholder until Tyler deploys). Users do not need a Cloudflare account.

## Install

1. If this skill is already loaded, the plugin is installed. Confirm the `skiherd` MCP server is connected.
2. If the user is installing from the repo, ask them to connect the SkiHerd plugin (Marketplace, Plugins sidebar, or an in-chat Connect card) and complete any permission dialog.
3. If MCP is not connected, tell them to add the Streamable HTTP server at `https://skiherd.jewell-labs.com/mcp`.

## Location permission

Request device location **once**, when you first need to post a heartbeat or show the user on the map. Reuse that permission for later heartbeats in this group. Do not start background tracking unless the user asks. Do not read location just to plan or chat.

## Profile fields

Reuse a known profile display name (or the name the user already gave you). Ask, via an in-chat form, only for fields you do not already know. Phase 1 only needs a display name — no email, no phone, no account.

## Start a group

1. Call `create_group` with the display name.
2. Show the host the map URL and tell them the group and all of its data disappear 24 hours after creation.
3. When they want friends on the map, call `create_invite` and share the invite URL — not the member token.
4. Friends who have the plugin call `join_group` with the invite token and their display name.
5. Post locations with `post_heartbeat` (a batch is better than a single 5-minute point). Prefer an on-device track uploaded in batches.
6. Answer questions with `group_map`, `group_stats`, `runs_not_hit`, and `suggest_new_route`.

Cap is 10 members. Do not log raw coordinates or tokens in chat history more than the user needs. This project is not affiliated with Winter Park Resort.

## Later

A “Use app on your phone” action will install a PWA from the same site, with the same UI plus live streaming. The backend stays the same. Paid tiers, longer storage, and AI features are not available in this version.
