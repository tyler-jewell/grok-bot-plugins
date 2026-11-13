import osm from "../data/winter-park-osm.json";

export type Trail = {
  name: string;
  difficulty: string;
  lengthM: number;
  start: { lat: number; lon: number };
  end: { lat: number; lon: number };
};

export type Lift = {
  name: string;
  kind: string;
  start: { lat: number; lon: number };
  end: { lat: number; lon: number };
};

const R = 6_371_000;

function hav(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dlat = lat2 - lat1;
  const dlon = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function pathLength(geom: { lat: number; lon: number }[]): number {
  let n = 0;
  for (let i = 0; i < geom.length - 1; i++) n += hav(geom[i], geom[i + 1]);
  return n;
}

function load(): { trails: Trail[]; lifts: Lift[] } {
  const elements = (osm as { elements: Array<Record<string, unknown>> }).elements;
  const trailMap = new Map<string, Trail>();
  const lifts: Lift[] = [];
  for (const el of elements) {
    const tags = (el.tags as Record<string, string> | undefined) ?? {};
    const geom = (el.geometry as { lat: number; lon: number }[] | undefined) ?? [];
    if (!tags.name || geom.length === 0) continue;
    if (tags.aerialway && tags.aerialway !== "station") {
      lifts.push({
        name: tags.name,
        kind: tags.aerialway,
        start: geom[0],
        end: geom[geom.length - 1],
      });
    } else if (tags["piste:type"] === "downhill") {
      const lengthM = pathLength(geom);
      const existing = trailMap.get(tags.name);
      if (!existing || lengthM > existing.lengthM) {
        trailMap.set(tags.name, {
          name: tags.name,
          difficulty: tags["piste:difficulty"] ?? "unknown",
          lengthM,
          start: geom[0],
          end: geom[geom.length - 1],
        });
      }
    }
  }
  return { trails: [...trailMap.values()], lifts };
}

const MOUNTAIN = load();

export function allTrails(): Trail[] {
  return MOUNTAIN.trails;
}

export function allLifts(): Lift[] {
  return MOUNTAIN.lifts;
}

export function runsNotHit(visitedNames: Iterable<string>): Trail[] {
  const seen = new Set([...visitedNames].map((n) => n.toLowerCase()));
  return MOUNTAIN.trails.filter((t) => !seen.has(t.name.toLowerCase()));
}

export function suggestRoute(
  from: { lat: number; lon: number } | null,
  visitedNames: Iterable<string>,
): { trail: Trail; lift: Lift | null; rationale: string } | null {
  const remaining = runsNotHit(visitedNames);
  if (remaining.length === 0) return null;
  const origin = from ?? { lat: 39.88586, lon: -105.76218 };
  let best = remaining[0];
  let bestD = Infinity;
  for (const t of remaining) {
    const d = Math.min(hav(origin, t.start), hav(origin, t.end));
    if (d < bestD) {
      best = t;
      bestD = d;
    }
  }
  let lift: Lift | null = null;
  let liftD = Infinity;
  for (const L of MOUNTAIN.lifts) {
    const d = Math.min(hav(L.end, best.start), hav(L.start, best.start));
    if (d < liftD) {
      lift = L;
      liftD = d;
    }
  }
  const rationale = lift
    ? `You have not skied ${best.name} (${best.difficulty}). ${lift.name} finishes about ${Math.round(liftD)} m from the top of that trail.`
    : `You have not skied ${best.name} (${best.difficulty}).`;
  return { trail: best, lift, rationale };
}
