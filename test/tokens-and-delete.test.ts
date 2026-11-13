import { runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AUTH_TIMEOUT_MS, SkiGroup } from "../src/group";

function stub(name: string) {
  return env.GROUP.get(env.GROUP.idFromName(name));
}

async function createHttp(name: string, ip: string) {
  const res = await SELF.fetch("https://skiherd.jewell-labs.com/api/groups", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ host_name: name }),
  });
  expect(res.status).toBe(201);
  return res.json<{ group_token: string; member_token: string; member_map_url: string; host_url: string }>();
}

describe("member tokens stay out of query strings (#12)", () => {
  it("includes a fragment member_map_url and a token-free host_url", async () => {
    const body = await createHttp("Tyler", "203.0.113.60");
    expect(body.member_map_url).toMatch(/\/g\/[0-9a-f]+#t=[0-9a-f]+$/i);
    expect(body.host_url).not.toContain("member_token");
    expect(body.host_url).not.toContain("#t=");
    expect(body.member_map_url).not.toContain("?member_token=");
  });

  it("rejects member_token in the query string on HTTP APIs even with a valid token", async () => {
    const body = await createHttp("Tyler", "203.0.113.61");
    const rejected = await SELF.fetch(
      `https://skiherd.jewell-labs.com/api/groups/${body.group_token}/map?member_token=${body.member_token}`,
    );
    expect(rejected.status).toBe(400);
    const payload = await rejected.json<{ error: string; code?: string }>();
    expect(payload.code).toBe("invalid_request");
    expect(payload.error).toMatch(/query string/i);

    const authed = await SELF.fetch(`https://skiherd.jewell-labs.com/api/groups/${body.group_token}/map`, {
      headers: { authorization: `Bearer ${body.member_token}` },
    });
    expect(authed.status).toBe(200);
  });

  it("rejects a WebSocket upgrade that puts the member token in the query string", async () => {
    const body = await createHttp("Tyler", "203.0.113.62");
    const res = await SELF.fetch(
      `https://skiherd.jewell-labs.com/g/${body.group_token}/ws?member_token=${body.member_token}`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(res.status).toBe(400);
    expect(res.webSocket).toBeNull();
    const payload = await res.json<{ error: string; code?: string }>();
    expect(payload.code).toBe("invalid_request");
  });

  it("requires a WebSocket upgrade on /g/:id/ws and does not cache that path as HTML", async () => {
    const body = await createHttp("Tyler", "203.0.113.70");
    const res = await SELF.fetch(`https://skiherd.jewell-labs.com/g/${body.group_token}/ws`);
    expect(res.status).toBe(426);
    expect(res.headers.get("cache-control") ?? "").toMatch(/no-store/i);
    const page = await SELF.fetch(`https://skiherd.jewell-labs.com/g/${body.group_token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control") ?? "").toMatch(/no-store/i);
  });

  it("authenticates a WebSocket with a first-message auth payload", async () => {
    const group = stub("test-ws-auth-" + crypto.randomUUID());
    const host = await group.create("Tyler");
    await runInDurableObject(group, async (inst: SkiGroup) => {
      const res = await inst.sessionWebSocket(new Request("https://skiherd.jewell-labs.com/ws", { headers: { Upgrade: "websocket" } }));
      expect(res.status).toBe(101);
      const ws = res.webSocket;
      expect(ws).toBeTruthy();
      if (!ws) throw new Error("expected a WebSocket");
      ws.accept();
      const got = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for authed")), 2000);
        ws.addEventListener("message", (event) => {
          clearTimeout(timer);
          resolve(String(event.data));
        });
        ws.addEventListener("close", (event) => {
          clearTimeout(timer);
          reject(new Error(`closed ${event.code} ${event.reason}`));
        });
      });
      ws.send(JSON.stringify({ type: "auth", member_token: host.member_token }));
      const message = JSON.parse(await got) as { type: string; member_id?: string };
      expect(message.type).toBe("authed");
      expect(message.member_id).toBeTruthy();
      ws.close();
    });
  });

  it("closes a WebSocket that does not authenticate in time", async () => {
    const group = stub("test-ws-timeout-" + crypto.randomUUID());
    await group.create("Tyler");
    await runInDurableObject(group, async (inst: SkiGroup) => {
      const res = await inst.sessionWebSocket(new Request("https://skiherd.jewell-labs.com/ws", { headers: { Upgrade: "websocket" } }));
      expect(res.status).toBe(101);
      const ws = res.webSocket;
      expect(ws).toBeTruthy();
      if (!ws) throw new Error("expected a WebSocket");
      ws.accept();
      const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("socket was not closed")), AUTH_TIMEOUT_MS + 2000);
        ws.addEventListener("close", (event) => {
          clearTimeout(timer);
          resolve({ code: event.code, reason: event.reason });
        });
      });
      const ev = await closed;
      expect(ev.code).toBe(1008);
      expect(ev.reason).toMatch(/auth timeout/i);
    });
  }, 10_000);
});

describe("any current member can delete (#13)", () => {
  it("lets a non-creator member delete the group and records deleted_by; other members then see gone", async () => {
    const group = stub("test-any-member-delete-" + crypto.randomUUID());
    const host = await group.create("Tyler");
    const invite = await group.createInvite(host.member_token, { max_uses: 1 });
    const guest = await group.join(invite.invite_token, "Alex");
    const deleted = await group.deleteGroup(guest.member_token);
    expect(deleted).toMatchObject({ deleted: true, deleted_by: { name: "Alex" } });
    expect(deleted.deleted_by.member_id).toBe(guest.member_id);

    const hostSees = await (async () => {
      try {
        await group.groupMap(host.member_token);
        return { threw: false, message: "" };
      } catch (err) {
        return { threw: true, message: err instanceof Error ? err.message : String(err) };
      }
    })();
    expect(hostSees.threw).toBe(true);
    expect(hostSees.message).toMatch(/deleted|expired|not found/i);
    expect(hostSees.message).not.toMatch(/no such table|SQLITE/i);
  });
});
