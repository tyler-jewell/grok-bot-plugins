# SkiHerd plugin

Live group ski map and heartbeat stats for up to 10 people.

**Hosted free by Tyler Jewell, bare minimum, no data kept, everything deleted after 24h.**

**Connect any agent: add MCP URL https://skiherd.jewell-labs.com/mcp, then say 'run the SkiHerd setup'.**

Grok Bot first, then ChatGPT, Claude, or any MCP client via the same MCP URL. You do not need a Cloudflare account. Tyler hosts the Worker on his personal Cloudflare account under a jewell-labs.com subdomain.

The MCP server is self-describing. It tells the agent to run `healthcheck` first, then follow the `setup` skill. Those two skills ship in this plugin package and are also served over MCP (prompts, `skiherd://skills/...` resources, and the `get_skill` tool), so a bot that only added the MCP URL still has everything it needs.

This is not affiliated with Winter Park Resort. Map data © OpenStreetMap contributors.

See the repository README for architecture, terms, and the privacy note.
