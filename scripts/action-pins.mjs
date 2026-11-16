// Require each changed `uses: owner/repo@sha # vX` pin to equal the commit the
// tag points at. Annotated tags are dereferenced to the commit. Callers inject
// fetch so fixtures stay offline.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const USES = /^[ \t]*(?:-[ \t]*)?uses:[ \t]*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.\-/]+)@([^\s#]+)[ \t]*(#.*)?$/;
const SHA = /^[0-9a-f]{40}$/;

function flag(args, name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
  }
  return undefined;
}

export function parseUses(text) {
  const pins = [];
  for (const line of text.split(/\r?\n/)) {
    const match = USES.exec(line);
    if (!match) {
      if (/^\s*-?\s*uses:\s*\S+@/.test(line)) {
        pins.push({ raw: line.trim(), action: line.trim(), owner: "", repo: "", sha: "", tag: "", broken: true });
      }
      continue;
    }
    const action = match[1];
    const ref = match[2];
    const comment = match[3] ?? "";
    const parts = action.split("/");
    const tag = /^#\s*(v\d+\.\d+\.\d+)\s*$/.exec(comment);
    pins.push({
      raw: line.trim(),
      action,
      owner: parts[0] ?? "",
      repo: parts[1] ?? "",
      sha: SHA.test(ref) ? ref : "",
      tag: tag ? tag[1] : "",
      broken: !SHA.test(ref),
    });
  }
  return pins;
}

async function readJson(doFetch, url) {
  const response = await doFetch(url, githubInit());
  if (!response.ok) throw new Error(`github status ${response.status} for ${url}`);
  return response.json();
}

function githubInit() {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "grok-bot-plugins-provenance",
    "x-github-api-version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return { headers };
}

export async function resolveTag(owner, repo, tag, fetchImpl) {
  const doFetch = fetchImpl ?? ((url) => fetch(url, githubInit()));
  const refUrl = `https://api.github.com/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`;
  const ref = await readJson(doFetch, refUrl);
  const object = ref.object;
  if (object === undefined || typeof object.type !== "string" || typeof object.sha !== "string") {
    throw new Error(`tag ${owner}/${repo}@${tag} has no object`);
  }
  if (object.type === "commit") return requireSha(object.sha);
  if (object.type === "tag") {
    const tagUrl = `https://api.github.com/repos/${owner}/${repo}/git/tags/${object.sha}`;
    const annotated = await readJson(doFetch, tagUrl);
    if (annotated.object?.type !== "commit" || typeof annotated.object.sha !== "string") {
      throw new Error(`annotated tag ${owner}/${repo}@${tag} did not point at a commit`);
    }
    return requireSha(annotated.object.sha);
  }
  throw new Error(`unexpected ref type ${object.type}`);
}

function requireSha(sha) {
  if (!SHA.test(sha)) throw new Error("resolved object is not a 40-hex commit");
  return sha;
}

export async function checkWorkflow(baseText, headText, resolve) {
  const seen = new Set(parseUses(baseText).map((pin) => pin.raw));
  const violations = [];
  for (const pin of parseUses(headText)) {
    if (seen.has(pin.raw)) continue;
    if (pin.broken || pin.sha === "") {
      violations.push({ package: pin.action, rule: "not-sha-pinned" });
      continue;
    }
    if (pin.tag === "") {
      violations.push({ package: pin.action, rule: "missing-tag-comment" });
      continue;
    }
    try {
      const commit = await resolve(pin.owner, pin.repo, pin.tag);
      if (commit !== pin.sha) violations.push({ package: pin.action, rule: "sha-mismatch" });
    } catch {
      violations.push({ package: pin.action, rule: "tag-resolve" });
    }
  }
  return violations;
}

function gitShow(repo, rev, file) {
  const result = spawnSync("git", ["-C", repo, "show", `${rev}:${file}`], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout;
}

function readChanged(file) {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function resolverFrom(resolutionsPath) {
  if (resolutionsPath === undefined) return (owner, repo, tag) => resolveTag(owner, repo, tag);
  const map = JSON.parse(readFileSync(resolutionsPath, "utf8"));
  const fetchImpl = async (url) => {
    if (!Object.prototype.hasOwnProperty.call(map, url)) throw new Error(`no fixture for ${url}`);
    return { ok: true, status: 200, json: async () => map[url] };
  };
  return (owner, repo, tag) => resolveTag(owner, repo, tag, fetchImpl);
}

async function main() {
  const args = process.argv.slice(2);
  const base = flag(args, "--base");
  const head = flag(args, "--head");
  const repo = flag(args, "--repo");
  const baseRev = flag(args, "--base-rev");
  const headRev = flag(args, "--head-rev");
  const changed = flag(args, "--changed");
  const resolve = resolverFrom(flag(args, "--resolutions"));
  const pairs = [];
  if (base !== undefined && head !== undefined) {
    pairs.push([readFileSync(base, "utf8"), readFileSync(head, "utf8")]);
  } else if (repo !== undefined && baseRev !== undefined && headRev !== undefined && changed !== undefined) {
    for (const file of readChanged(changed)) {
      if (!file.startsWith(".github/workflows/") || (!file.endsWith(".yml") && !file.endsWith(".yaml"))) continue;
      const headText = gitShow(repo, headRev, file);
      if (headText === null) {
        console.log(`package=${file} rule=workflow-missing`);
        process.exit(1);
      }
      pairs.push([gitShow(repo, baseRev, file) ?? "", headText]);
    }
  } else {
    console.error("usage: action-pins.mjs (--base <file> --head <file> | --repo <dir> --base-rev <rev> --head-rev <rev> --changed <file>) [--resolutions <file>]");
    process.exit(2);
  }
  const violations = [];
  for (const [baseText, headText] of pairs) {
    violations.push(...await checkWorkflow(baseText, headText, resolve));
  }
  for (const violation of violations) {
    console.log(`package=${violation.package} rule=${violation.rule}`);
  }
  if (violations.length > 0) process.exit(1);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) main();
