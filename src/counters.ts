import { DurableObject } from "cloudflare:workers";

/** One object for the whole worker. The name is not a group id. */
export const COUNTER_OBJECT_NAME = "daily";

/** Rows older than this many UTC days are deleted by the object's alarm. */
export const COUNTER_RETAIN_DAYS = 35;

const DAY_MS = 86_400_000;

/**
 * Names the worker is allowed to store. Anything else (tokens, ids, names,
 * coordinates, addresses) is rejected and not written.
 */
const ALLOWED_NAME =
  /^(created|deleted|expired|rate_limit:(create|join|invite|heartbeat)|error:[45]xx)$/;

export type CounterRow = { day: string; name: string; value: number };

export type CounterSnapshot = {
  days: Array<{ day: string; counters: Record<string, number> }>;
};

export function limiterCounter(name: "create" | "join" | "invite" | "hb"): string {
  return name === "hb" ? "rate_limit:heartbeat" : `rate_limit:${name}`;
}

export function statusCounter(status: number): "error:4xx" | "error:5xx" | null {
  if (status >= 400 && status <= 499) return "error:4xx";
  if (status >= 500 && status <= 599) return "error:5xx";
  return null;
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A counter outage must not change the request that was being counted. */
export async function noteCounter(env: Env, name: string): Promise<void> {
  try {
    await env.COUNTERS.get(env.COUNTERS.idFromName(COUNTER_OBJECT_NAME)).add(name);
  } catch {
    /* binding or RPC failure: the group operation still stands */
  }
}

function asInt(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" ? value : Number(value);
}

/**
 * Singleton SQLite Durable Object. Each row is a UTC day, a counter name,
 * and an integer. No other columns exist.
 */
export class DailyCounters extends DurableObject<Env> {
  private ensure(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS counters (
        day TEXT NOT NULL,
        name TEXT NOT NULL,
        value INTEGER NOT NULL,
        PRIMARY KEY (day, name)
      )
    `);
  }

  async add(name: string, atMs?: number): Promise<{ ok: true } | { ok: false }> {
    try {
      if (typeof name !== "string" || !ALLOWED_NAME.test(name)) return { ok: false };
      const when = typeof atMs === "number" && Number.isFinite(atMs) ? Math.trunc(atMs) : Date.now();
      const day = utcDay(when);
      this.ensure();
      const current = this.ctx.storage.sql
        .exec<{ value: number }>("SELECT value FROM counters WHERE day = ? AND name = ?", day, name)
        .toArray()[0];
      if (current === undefined) {
        this.ctx.storage.sql.exec("INSERT INTO counters (day, name, value) VALUES (?, ?, 1)", day, name);
      } else {
        this.ctx.storage.sql.exec(
          "UPDATE counters SET value = ? WHERE day = ? AND name = ?",
          asInt(current.value) + 1,
          day,
          name,
        );
      }
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null) {
        const next = Date.parse(`${utcDay(Date.now())}T00:00:00.000Z`) + DAY_MS;
        await this.ctx.storage.setAlarm(next);
      }
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  async rows(): Promise<CounterRow[]> {
    try {
      this.ensure();
      return this.ctx.storage.sql
        .exec<{ day: string; name: string; value: number }>(
          "SELECT day, name, value FROM counters ORDER BY day, name",
        )
        .toArray()
        .map((row) => ({ day: row.day, name: row.name, value: asInt(row.value) }));
    } catch {
      return [];
    }
  }

  async snapshot(): Promise<CounterSnapshot> {
    const byDay = new Map<string, Record<string, number>>();
    for (const row of await this.rows()) {
      const counters = byDay.get(row.day) ?? {};
      counters[row.name] = row.value;
      byDay.set(row.day, counters);
    }
    return { days: [...byDay.entries()].map(([day, counters]) => ({ day, counters })) };
  }

  /** Drop days strictly older than {@link COUNTER_RETAIN_DAYS}, then schedule the next pass. */
  async alarm(): Promise<void> {
    try {
      this.ensure();
      const cutoff = utcDay(Date.now() - COUNTER_RETAIN_DAYS * DAY_MS);
      this.ctx.storage.sql.exec("DELETE FROM counters WHERE day < ?", cutoff);
    } catch {
      /* still reschedule below */
    }
    try {
      await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
    } catch {
      /* the next add() schedules when no alarm is set */
    }
  }
}
