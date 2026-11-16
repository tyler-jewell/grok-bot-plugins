// Pure release-lifecycle logic. No Node or Worker APIs so it is testable anywhere.
const TAG_RE = /^prod\/(\d{4}\.\d{2}\.\d{2})\+([1-9]\d*)$/;

/** Parse lines of "<tag> <commit-sha>" into [{ tag, sha }]. Skips incomplete lines. */
export function parseTags(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const [tag, sha] = line.trim().split(/\s+/);
    if (tag && sha) out.push({ tag, sha });
  }
  return out;
}

/** UTC date as YYYY.MM.DD. */
export function formatDate(date) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(date.getUTCFullYear(), 4)}.${p(date.getUTCMonth() + 1)}.${p(date.getUTCDate())}`;
}

/** Next tag prod/<date>+N: highest existing N for that date + 1, or 1. Malformed tags are ignored. */
export function nextTag(tags, date) {
  let max = 0;
  for (const { tag } of tags) {
    const m = TAG_RE.exec(tag);
    if (m && m[1] === date) max = Math.max(max, Number(m[2]));
  }
  return `prod/${date}+${max + 1}`;
}

/** The well-formed prod tag already pointing at sha, or null. */
export function findReleased(tags, sha) {
  const hit = tags.find((t) => t.sha === sha && TAG_RE.test(t.tag));
  return hit ? hit.tag : null;
}

/** Promote guards. Returns { ok: true } or { ok: false, reason }. */
export function checkGuards({ confirm, ref, sha, mainHead, candidateArtifacts }) {
  if (confirm !== "promote-staging") return { ok: false, reason: "confirm must equal promote-staging" };
  if (ref !== "refs/heads/main") return { ok: false, reason: `must run from refs/heads/main, got ${ref}` };
  if (!sha || sha !== mainHead) return { ok: false, reason: `sha ${sha} is not the current main head ${mainHead}` };
  if (!(candidateArtifacts >= 1)) return { ok: false, reason: `no candidate artifact for ${sha}` };
  return { ok: true };
}
