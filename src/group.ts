import { DurableObject } from "cloudflare:workers";
import { runsNotHit, suggestRoute } from "./mountain";
import { randomToken, sha256Hex, timingSafeEqual } from "./tokens";

export const COLORS = ["#2F6FED", "#E85D04", "#0B7A4B", "#7B2CBF", "#C1121F", "#0077B6", "#9A031E", "#2D6A4F", "#6A4C93", "#B08968"];

export type HeartbeatIn = {
  ts: string;
  lat: number;
  lon: number;
  alt_m?: number | null;
  accuracy_m?: number | null;
  speed_mps?: number | null;
  heading_deg?: number | null;
  battery_pct?: number | null;
  activity?: string | null;
  place?: string | null;
  lift_or_trail?: string | null;
  difficulty?: string | null;
};

type MemberRow = {
  id: string;
  display_name: string;
  color: string;
  token_hash: string;
  joined_at: number;
};

export type GroupInfo = {
  group_token: string;
  created_at: string;
  expires_at: string;
  member_count: number;
  max_members: number;
};

export class SkiGroup extends DurableObject<Env> {
  /** Set after deleteAll on this still-resident instance. Constructor does not re-run. */
  private wiped = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
    });
  }

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          k TEXT PRIMARY KEY,
          v TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS members (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          color TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          joined_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS invites (
          token_hash TEXT PRIMARY KEY,
          created_by TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          max_uses INTEGER NOT NULL,
          uses INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS heartbeats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id TEXT NOT NULL,
          ts INTEGER NOT NULL,
          lat REAL NOT NULL,
          lon REAL NOT NULL,
          alt_m REAL,
          accuracy_m REAL,
          speed_mps REAL,
          heading_deg REAL,
          battery_pct REAL,
          activity TEXT,
          place TEXT,
          lift_or_trail TEXT,
          difficulty TEXT
        );
        CREATE INDEX IF NOT EXISTS hb_member_ts ON heartbeats (member_id, ts);
        CREATE INDEX IF NOT EXISTS hb_trail ON heartbeats (lift_or_trail);
      `);
  }

  private hasSchema(): boolean {
    try {
      const row = this.ctx.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
        .toArray()[0];
      return Boolean(row);
    } catch (err) {
      if (isMissingSchema(err)) return false;
      throw err;
    }
  }

  private maxMembers(): number {
    return Number(this.env.MAX_GROUP_MEMBERS ?? 10);
  }

  private ttlMs(): number {
    return Number(this.env.GROUP_TTL_MS ?? 86_400_000);
  }

  private meta(k: string): string | null {
    if (!this.hasSchema()) return null;
    try {
      const row = this.ctx.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray()[0];
      return row?.v ?? null;
    } catch (err) {
      if (isMissingSchema(err)) return null;
      throw err;
    }
  }

  private setMeta(k: string, v: string): void {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", k, v);
  }

  private isExpired(): boolean {
    const exp = this.meta("expires_at");
    if (!exp) return false;
    return Date.now() >= Number(exp);
  }

  private gone(message = "group expired"): never {
    throw new GroupGoneError(message);
  }

  private hasCreatedGroup(): boolean {
    if (this.wiped || !this.hasSchema()) return false;
    return this.meta("created_at") != null;
  }

  private assertLive(): void {
    if (this.wiped || !this.hasSchema()) this.gone("group deleted");
    if (this.meta("created_at") == null) throw new GroupNotFoundError();
    if (this.isExpired()) this.gone();
  }

  private closeAllSockets(): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "group deleted");
      } catch {
        /* already closing */
      }
    }
  }

  private async wipe(reason: "deleted" | "expired"): Promise<void> {
    this.broadcast({ type: "gone", reason });
    this.closeAllSockets();
    try {
      await this.ctx.storage.deleteAlarm();
    } catch {
      /* alarm already gone */
    }
    await this.ctx.storage.deleteAll();
    this.wiped = true;
  }

  private nextColor(): string {
    const used = new Set(
      this.ctx.storage.sql.exec<{ color: string }>("SELECT color FROM members").toArray().map((r) => r.color),
    );
    return COLORS.find((c) => !used.has(c)) ?? COLORS[0];
  }

  async create(hostName: string): Promise<{
    group_token: string;
    member_token: string;
    member_id: string;
    expires_at: string;
    created_at: string;
  }> {
    if (this.hasCreatedGroup() && this.isExpired()) {
      await this.wipe("expired");
    }
    if (this.hasCreatedGroup()) {
      throw new Error("group already exists");
    }
    this.ensureSchema();
    this.wiped = false;
    // Do not resurrect leftovers if anything survived the wipe.
    this.ctx.storage.sql.exec("DELETE FROM heartbeats");
    this.ctx.storage.sql.exec("DELETE FROM invites");
    this.ctx.storage.sql.exec("DELETE FROM members");
    this.ctx.storage.sql.exec("DELETE FROM meta");
    const created = Date.now();
    const expires = created + this.ttlMs();
    const groupToken = this.ctx.id.name ?? this.ctx.id.toString();
    const memberId = randomToken(16);
    const memberToken = randomToken(32);
    const tokenHash = await sha256Hex(memberToken);
    this.setMeta("created_at", String(created));
    this.setMeta("expires_at", String(expires));
    this.setMeta("group_token", groupToken);
    this.setMeta("host_id", memberId);
    this.ctx.storage.sql.exec(
      "INSERT INTO members (id, display_name, color, token_hash, joined_at) VALUES (?, ?, ?, ?, ?)",
      memberId,
      hostName.slice(0, 40) || "Host",
      COLORS[0],
      tokenHash,
      created,
    );
    await this.ctx.storage.setAlarm(expires);
    this.broadcast({ type: "created" });
    return {
      group_token: groupToken,
      member_token: memberToken,
      member_id: memberId,
      expires_at: new Date(expires).toISOString(),
      created_at: new Date(created).toISOString(),
    };
  }

  async alarm(): Promise<void> {
    // 24h self-delete: wipe all storage. No data kept.
    await this.wipe("expired");
  }

  async info(memberToken: string): Promise<GroupInfo> {
    await this.authMember(memberToken);
    const n = this.ctx.storage.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM members").one().c;
    return {
      group_token: this.meta("group_token") ?? "",
      created_at: new Date(Number(this.meta("created_at"))).toISOString(),
      expires_at: new Date(Number(this.meta("expires_at"))).toISOString(),
      member_count: n,
      max_members: this.maxMembers(),
    };
  }

  private async authMember(memberToken: string): Promise<MemberRow> {
    this.assertLive();
    const hash = await sha256Hex(memberToken);
    const row = this.ctx.storage.sql
      .exec<MemberRow>("SELECT id, display_name, color, token_hash, joined_at FROM members WHERE token_hash = ?", hash)
      .toArray()[0];
    if (!row || !timingSafeEqual(row.token_hash, hash)) throw new UnauthorizedError();
    return row;
  }

  async createInvite(
    memberToken: string,
    opts?: { ttl_ms?: number; max_uses?: number },
  ): Promise<{ invite_token: string; expires_at: string; max_uses: number }> {
    const member = await this.authMember(memberToken);
    const seats = this.maxMembers() - this.ctx.storage.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM members").one().c;
    if (seats <= 0) throw new GroupFullError();
    const ttl = Math.min(Math.max(opts?.ttl_ms ?? 3_600_000, 60_000), Number(this.meta("expires_at")) - Date.now());
    const maxUses = Math.min(Math.max(opts?.max_uses ?? 1, 1), seats);
    const token = randomToken(32);
    const hash = await sha256Hex(token);
    this.ctx.storage.sql.exec(
      "INSERT INTO invites (token_hash, created_by, expires_at, max_uses, uses) VALUES (?, ?, ?, ?, 0)",
      hash,
      member.id,
      Date.now() + ttl,
      maxUses,
    );
    return { invite_token: token, expires_at: new Date(Date.now() + ttl).toISOString(), max_uses: maxUses };
  }

  async join(inviteToken: string, displayName: string): Promise<{ member_token: string; member_id: string; expires_at: string }> {
    this.assertLive();
    const hash = await sha256Hex(inviteToken);
    const inv = this.ctx.storage.sql
      .exec<{ token_hash: string; expires_at: number; max_uses: number; uses: number }>(
        "SELECT token_hash, expires_at, max_uses, uses FROM invites WHERE token_hash = ?",
        hash,
      )
      .toArray()[0];
    if (!inv || !timingSafeEqual(inv.token_hash, hash)) throw new UnauthorizedError("invalid invite");
    if (Date.now() >= inv.expires_at) throw new UnauthorizedError("invite expired");
    if (inv.uses >= inv.max_uses) throw new UnauthorizedError("invite already used");
    const count = this.ctx.storage.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM members").one().c;
    if (count >= this.maxMembers()) throw new GroupFullError();
    const memberId = randomToken(16);
    const memberToken = randomToken(32);
    const tokenHash = await sha256Hex(memberToken);
    const color = this.nextColor();
    this.ctx.storage.sql.exec(
      "INSERT INTO members (id, display_name, color, token_hash, joined_at) VALUES (?, ?, ?, ?, ?)",
      memberId,
      (displayName || "Skier").slice(0, 40),
      color,
      tokenHash,
      Date.now(),
    );
    this.ctx.storage.sql.exec("UPDATE invites SET uses = uses + 1 WHERE token_hash = ?", hash);
    this.broadcast({ type: "joined", name: displayName });
    return {
      member_token: memberToken,
      member_id: memberId,
      expires_at: new Date(Number(this.meta("expires_at"))).toISOString(),
    };
  }

  async postHeartbeat(memberToken: string, points: HeartbeatIn[]): Promise<{ accepted: number }> {
    const member = await this.authMember(memberToken);
    if (!Array.isArray(points) || points.length === 0) return { accepted: 0 };
    if (points.length > 500) throw new Error("batch too large");
    let accepted = 0;
    for (const p of points) {
      const lat = finiteNumber(p.lat);
      const lon = finiteNumber(p.lon);
      if (lat == null || lon == null) continue;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
      const ts = p.ts ? Date.parse(p.ts) : Date.now();
      if (!Number.isFinite(ts)) continue;
      this.ctx.storage.sql.exec(
        `INSERT INTO heartbeats (member_id, ts, lat, lon, alt_m, accuracy_m, speed_mps, heading_deg, battery_pct, activity, place, lift_or_trail, difficulty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        member.id,
        ts,
        lat,
        lon,
        finiteNumber(p.alt_m),
        finiteNumber(p.accuracy_m),
        finiteNumber(p.speed_mps),
        finiteNumber(p.heading_deg),
        finiteNumber(p.battery_pct),
        p.activity ?? null,
        p.place ?? null,
        p.lift_or_trail ?? null,
        p.difficulty ?? null,
      );
      accepted += 1;
    }
    if (accepted) this.broadcast({ type: "heartbeat", member_id: member.id });
    return { accepted };
  }

  async groupMap(memberToken: string): Promise<{
    expires_at: string;
    members: Array<{
      id: string;
      name: string;
      color: string;
      lat: number | null;
      lon: number | null;
      alt_m: number | null;
      speed_mps: number | null;
      heading_deg: number | null;
      activity: string | null;
      place: string | null;
      lift_or_trail: string | null;
      last_seen: string | null;
      stale: boolean;
    }>;
  }> {
    await this.authMember(memberToken);
    const members = this.ctx.storage.sql.exec<MemberRow>("SELECT id, display_name, color, token_hash, joined_at FROM members").toArray();
    const last = this.ctx.storage.sql
      .exec<{
        member_id: string;
        ts: number;
        lat: number;
        lon: number;
        alt_m: number | null;
        speed_mps: number | null;
        heading_deg: number | null;
        activity: string | null;
        place: string | null;
        lift_or_trail: string | null;
      }>(
        `SELECT h.member_id, h.ts, h.lat, h.lon, h.alt_m, h.speed_mps, h.heading_deg, h.activity, h.place, h.lift_or_trail
         FROM heartbeats h
         JOIN (SELECT member_id, MAX(ts) AS ts FROM heartbeats GROUP BY member_id) t
           ON h.member_id = t.member_id AND h.ts = t.ts`,
      )
      .toArray();
    const byId = new Map(last.map((r) => [r.member_id, r]));
    const now = Date.now();
    return {
      expires_at: new Date(Number(this.meta("expires_at"))).toISOString(),
      members: members.map((m) => {
        const h = byId.get(m.id);
        const age = h ? now - h.ts : Infinity;
        return {
          id: m.id,
          name: m.display_name,
          color: m.color,
          lat: h?.lat ?? null,
          lon: h?.lon ?? null,
          alt_m: h?.alt_m ?? null,
          speed_mps: h?.speed_mps ?? null,
          heading_deg: h?.heading_deg ?? null,
          activity: h?.activity ?? null,
          place: h?.place ?? null,
          lift_or_trail: h?.lift_or_trail ?? null,
          last_seen: h ? new Date(h.ts).toISOString() : null,
          stale: age > 10 * 60 * 1000,
        };
      }),
    };
  }

  async groupStats(memberToken: string): Promise<{
    members: Array<{
      id: string;
      name: string;
      points: number;
      distance_km: number;
      descent_m: number;
      descent_ft: number;
      top_speed_mps: number;
      top_speed_mph: number;
      runs: number;
      run_names: string[];
      hours_run: number;
      hours_lift: number;
      hours_lodge: number;
    }>;
  }> {
    await this.authMember(memberToken);
    const members = this.ctx.storage.sql.exec<{ id: string; display_name: string }>("SELECT id, display_name FROM members").toArray();
    const out = [];
    for (const m of members) {
      const pts = this.ctx.storage.sql
        .exec<{ ts: number; lat: number; lon: number; alt_m: number | null; speed_mps: number | null; activity: string | null; lift_or_trail: string | null }>(
          "SELECT ts, lat, lon, alt_m, speed_mps, activity, lift_or_trail FROM heartbeats WHERE member_id = ? ORDER BY ts ASC",
          m.id,
        )
        .toArray();
      out.push({ id: m.id, name: m.display_name, ...statsFrom(pts) });
    }
    return { members: out };
  }

  async runsNotHit(memberToken: string): Promise<{ visited: string[]; not_hit: Array<{ name: string; difficulty: string }> }> {
    await this.authMember(memberToken);
    const visited = this.ctx.storage.sql
      .exec<{ lift_or_trail: string }>(
        "SELECT DISTINCT lift_or_trail FROM heartbeats WHERE lift_or_trail IS NOT NULL AND lift_or_trail != '' AND activity = 'run'",
      )
      .toArray()
      .map((r) => r.lift_or_trail);
    const notHit = runsNotHit(visited).map((t) => ({ name: t.name, difficulty: t.difficulty }));
    return { visited, not_hit: notHit };
  }

  async suggestNewRoute(memberToken: string): Promise<{ trail: string; difficulty: string; lift: string | null; rationale: string } | { none: true }> {
    const map = await this.groupMap(memberToken);
    const visited = (await this.runsNotHit(memberToken)).visited;
    const withFix = map.members.find((m) => m.lat != null && m.lon != null);
    const from = withFix && withFix.lat != null && withFix.lon != null ? { lat: withFix.lat, lon: withFix.lon } : null;
    const suggestion = suggestRoute(from, visited);
    if (!suggestion) return { none: true };
    return {
      trail: suggestion.trail.name,
      difficulty: suggestion.trail.difficulty,
      lift: suggestion.lift?.name ?? null,
      rationale: suggestion.rationale,
    };
  }

  async leave(memberToken: string): Promise<{ left: true; group_deleted: boolean }> {
    const member = await this.authMember(memberToken);
    this.ctx.storage.sql.exec("DELETE FROM heartbeats WHERE member_id = ?", member.id);
    this.ctx.storage.sql.exec("DELETE FROM members WHERE id = ?", member.id);
    const remaining = this.ctx.storage.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM members").one().c;
    this.broadcast({ type: "left", member_id: member.id });
    if (remaining <= 0) {
      await this.wipe("deleted");
      return { left: true, group_deleted: true };
    }
    return { left: true, group_deleted: false };
  }

  async deleteGroup(memberToken: string): Promise<{ deleted: true }> {
    const member = await this.authMember(memberToken);
    const hostId = this.meta("host_id");
    if (!hostId || member.id !== hostId) throw new UnauthorizedError("only the creator can delete this group");
    await this.wipe("deleted");
    return { deleted: true };
  }

  /**
   * Ephemeral probe used by healthcheck. Only allowed on objects whose name
   * starts with __skiherd_health__. Writes, reads, schedules an alarm, then
   * wipes all storage so no user data is kept.
   */
  async healthProbe(): Promise<{ storage_write: boolean; storage_read: boolean; alarm_scheduled: boolean }> {
    const name = this.ctx.id.name ?? "";
    if (!name.startsWith("__skiherd_health__")) {
      throw new Error("health probe is only allowed on ephemeral health objects");
    }
    if (this.wiped || !this.hasSchema()) this.ensureSchema();
    this.wiped = false;
    const marker = `probe:${Date.now()}`;
    this.setMeta("health_probe", marker);
    const storage_write = true;
    const storage_read = this.meta("health_probe") === marker;
    const when = Date.now() + 60_000;
    await this.ctx.storage.setAlarm(when);
    const alarm = await this.ctx.storage.getAlarm();
    const alarm_scheduled = typeof alarm === "number" && alarm >= when - 5_000;
    await this.wipe("deleted");
    return { storage_write, storage_read, alarm_scheduled };
  }

  async sessionWebSocket(request: Request, memberToken: string): Promise<Response> {

    await this.authMember(memberToken);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // Clients only receive; ignore inbound payloads besides pings.
    if (typeof _message === "string" && _message === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    ws.close();
  }

  private broadcast(payload: unknown): void {
    const msg = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        /* socket already closing */
      }
    }
  }
}

function isMissingSchema(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no such table/i.test(message) || /SQLITE_ERROR/i.test(message);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function havKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dlat = lat2 - lat1;
  const dlon = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function statsFrom(
  pts: Array<{
    ts: number;
    lat: number;
    lon: number;
    alt_m: number | null;
    speed_mps: number | null;
    activity: string | null;
    lift_or_trail: string | null;
  }>,
) {
  let dist = 0;
  let descent = 0;
  let top = 0;
  let hoursRun = 0;
  let hoursLift = 0;
  let hoursLodge = 0;
  const runNames: string[] = [];
  let block: string | null = null;
  for (let i = 0; i < pts.length; i++) {
    const s = pts[i];
    if (s.speed_mps && s.speed_mps > top) top = s.speed_mps;
    if (i) {
      const p = pts[i - 1];
      dist += havKm(p, s);
      if (p.alt_m != null && s.alt_m != null && s.alt_m < p.alt_m) descent += p.alt_m - s.alt_m;
      const dt = (s.ts - p.ts) / 3600_000;
      if (p.activity === "run") hoursRun += dt;
      else if (p.activity === "lift") hoursLift += dt;
      else if (p.activity === "lodge") hoursLodge += dt;
    }
    if (s.activity === "run" && s.lift_or_trail) {
      const key = s.lift_or_trail;
      if (block !== key) {
        runNames.push(key);
        block = key;
      }
    } else {
      block = null;
    }
  }
  return {
    points: pts.length,
    distance_km: Math.round(dist * 100) / 100,
    descent_m: Math.round(descent),
    descent_ft: Math.round(descent * 3.28084),
    top_speed_mps: Math.round(top * 100) / 100,
    top_speed_mph: Math.round(top * 2.23694 * 10) / 10,
    runs: runNames.length,
    run_names: runNames,
    hours_run: Math.round(hoursRun * 100) / 100,
    hours_lift: Math.round(hoursLift * 100) / 100,
    hours_lodge: Math.round(hoursLodge * 100) / 100,
  };
}

export class GroupGoneError extends Error {
  constructor(message = "group expired") {
    super(message);
    this.name = "GroupGoneError";
  }
}
export class GroupNotFoundError extends Error {
  constructor() {
    super("group not found");
    this.name = "GroupNotFoundError";
  }
}
export class UnauthorizedError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}
export class GroupFullError extends Error {
  constructor() {
    super("group is full (10 members)");
    this.name = "GroupFullError";
  }
}
