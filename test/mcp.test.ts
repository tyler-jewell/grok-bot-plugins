import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MCP_INSTRUCTIONS, SKILLS, SKILL_NAMES } from "../src/skills.generated";

type JsonRpc = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

async function mcp(body: object, session?: string): Promise<{ status: number; message: JsonRpc; session?: string; raw: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (session) headers["mcp-session-id"] = session;
  const res = await SELF.fetch("https://skiherd.jewell-labs.com/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const sid = res.headers.get("mcp-session-id") ?? session ?? undefined;
  const raw = await res.text();
  const method = (body as { method?: string }).method ?? "";
  const isNotification = method.startsWith("notifications/") || !("id" in (body as object));
  if (!raw.trim()) {
    if (isNotification && res.status < 400) return { status: res.status, message: {}, session: sid, raw };
    throw new Error(`empty MCP response (status ${res.status}) for ${method}`);
  }
  return { status: res.status, message: parseMcp(raw), session: sid, raw };
}

function parseMcp(raw: string): JsonRpc {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as JsonRpc;
  const datas: string[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) datas.push(line.slice(5).trim());
    }
  }
  if (!datas.length) throw new Error(`no MCP payload in: ${raw.slice(0, 500)}`);
  for (let i = datas.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(datas[i]) as JsonRpc;
      if (obj && typeof obj === "object" && ("result" in obj || "error" in obj || "method" in obj)) return obj;
    } catch {
      /* continue */
    }
  }
  return JSON.parse(datas[datas.length - 1]) as JsonRpc;
}

function resultOf(message: JsonRpc): Record<string, unknown> {
  if (message.error) throw new Error(`MCP error ${message.error.code}: ${message.error.message}`);
  if (!message.result || typeof message.result !== "object") throw new Error(`expected result, got ${JSON.stringify(message)}`);
  return message.result as Record<string, unknown>;
}

function toolJson(message: JsonRpc): unknown {
  const result = resultOf(message) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (text == null) throw new Error(`no text content in ${JSON.stringify(message)}`);
  return JSON.parse(text);
}

async function session(): Promise<string | undefined> {
  const init = await mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "skiherd-test", version: "0.0.0" },
    },
  });
  expect(init.status).toBe(200);
  const initialized = await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, init.session);
  expect([200, 202, 204]).toContain(initialized.status);
  return init.session;
}

describe("MCP self-description", () => {
  it("includes instructions on initialize", async () => {
    const init = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "skiherd-test", version: "0.0.0" },
      },
    });
    expect(init.status).toBe(200);
    const result = resultOf(init.message);
    expect(result.instructions).toBe(MCP_INSTRUCTIONS);
    expect(String(result.instructions)).toMatch(/healthcheck/i);
    expect(String(result.instructions)).toMatch(/setup/i);
    expect(String(result.instructions)).toMatch(/Do not create, join, or update a group until healthcheck returns ok: true/);
    const info = result.serverInfo as { name: string; version: string };
    expect(info.name).toBe("skiherd");
    expect(info.version).toBe("0.2.0");
  });

  it("serves both skills via prompts, resources, and get_skill, matching the repo files", async () => {
    const sid = await session();
    const prompts = resultOf(
      (await mcp({ jsonrpc: "2.0", id: 2, method: "prompts/list", params: {} }, sid)).message,
    ) as { prompts: Array<{ name: string }> };
    const resources = resultOf(
      (await mcp({ jsonrpc: "2.0", id: 3, method: "resources/list", params: {} }, sid)).message,
    ) as { resources: Array<{ uri: string; name?: string }> };
    expect(prompts.prompts.map((p) => p.name).sort()).toEqual([...SKILL_NAMES].sort());
    expect(resources.resources.map((r) => r.uri).sort()).toEqual(SKILL_NAMES.map((n) => `skiherd://skills/${n}`).sort());

    for (const name of SKILL_NAMES) {
      const prompt = resultOf(
        (await mcp({ jsonrpc: "2.0", id: 10, method: "prompts/get", params: { name } }, sid)).message,
      ) as { messages: Array<{ content: { type: string; text?: string } }> };
      expect(prompt.messages[0]?.content?.text).toBe(SKILLS[name]);

      const resource = resultOf(
        (
          await mcp(
            { jsonrpc: "2.0", id: 11, method: "resources/read", params: { uri: `skiherd://skills/${name}` } },
            sid,
          )
        ).message,
      ) as { contents: Array<{ uri: string; text?: string }> };
      expect(resource.contents[0]?.text).toBe(SKILLS[name]);

      const skill = await mcp(
        { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "get_skill", arguments: { name } } },
        sid,
      );
      const result = resultOf(skill.message) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content?.[0]?.text).toBe(SKILLS[name]);
    }
  });

  it("healthcheck tool passes in the test environment", async () => {
    const sid = await session();
    const call = await mcp({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "healthcheck", arguments: {} } }, sid);
    const body = toolJson(call.message) as { ok: boolean; components: Record<string, { ok: boolean }> };
    expect(body.ok).toBe(true);
    expect(body.components.durable_object.ok).toBe(true);
    expect(body.components.storage.ok).toBe(true);
    expect(body.components.alarm.ok).toBe(true);
  });
});

describe("MCP leave and delete", () => {
  it("lets a member leave and lets the creator delete the group", async () => {
    const sid = await session();
    const created = toolJson(
      (
        await mcp(
          { jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "create_group", arguments: { host_name: "Tyler" } } },
          sid,
        )
      ).message,
    ) as { group_token: string; member_token: string };

    const invite = toolJson(
      (
        await mcp(
          {
            jsonrpc: "2.0",
            id: 31,
            method: "tools/call",
            params: {
              name: "create_invite",
              arguments: { group_token: created.group_token, member_token: created.member_token, max_uses: 1 },
            },
          },
          sid,
        )
      ).message,
    ) as { invite_token: string };

    const joined = toolJson(
      (
        await mcp(
          {
            jsonrpc: "2.0",
            id: 32,
            method: "tools/call",
            params: {
              name: "join_group",
              arguments: { group_token: created.group_token, invite_token: invite.invite_token, display_name: "Alex" },
            },
          },
          sid,
        )
      ).message,
    ) as { member_token: string };

    const denied = resultOf(
      (
        await mcp(
          {
            jsonrpc: "2.0",
            id: 33,
            method: "tools/call",
            params: {
              name: "delete_group",
              arguments: { group_token: created.group_token, member_token: joined.member_token },
            },
          },
          sid,
        )
      ).message,
    ) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(denied.isError).toBe(true);
    expect(denied.content?.[0]?.text).toMatch(/unauthorized|creator/i);

    const left = toolJson(
      (
        await mcp(
          {
            jsonrpc: "2.0",
            id: 34,
            method: "tools/call",
            params: {
              name: "leave_group",
              arguments: { group_token: created.group_token, member_token: joined.member_token },
            },
          },
          sid,
        )
      ).message,
    ) as { left: boolean; group_deleted: boolean };
    expect(left).toEqual({ left: true, group_deleted: false });

    const deleted = toolJson(
      (
        await mcp(
          {
            jsonrpc: "2.0",
            id: 35,
            method: "tools/call",
            params: {
              name: "delete_group",
              arguments: { group_token: created.group_token, member_token: created.member_token },
            },
          },
          sid,
        )
      ).message,
    ) as { deleted: boolean };
    expect(deleted).toEqual({ deleted: true });

    const gone = resultOf(
      (
        await mcp(
          {
            jsonrpc: "2.0",
            id: 36,
            method: "tools/call",
            params: { name: "group_map", arguments: { group_token: created.group_token, member_token: created.member_token } },
          },
          sid,
        )
      ).message,
    ) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(gone.isError).toBe(true);
    const payload = JSON.parse(gone.content?.[0]?.text ?? "{}") as { error?: string; message?: string };
    expect(payload.error).toMatch(/gone|not_found/);
    expect(payload.message ?? "").not.toMatch(/no such table|SQLITE/i);
    expect(payload.message ?? "").toMatch(/deleted|expired|not found/i);
  });
});
