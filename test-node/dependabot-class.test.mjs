import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts/dependabot-class.mjs");
const workflow = join(root, ".github/workflows/dependabot.yml");

function lock(packages) {
  return JSON.stringify({
    name: "fixture",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "fixture" }, ...packages },
  });
}

function entry(name, version, extra = {}) {
  return {
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    integrity: `sha512-${name}-${version}`,
    ...extra,
  };
}

function classify(basePackages, headPackages, changed = "package-lock.json\n") {
  const dir = mkdtempSync(join(tmpdir(), "class-"));
  const base = join(dir, "base.json");
  const head = join(dir, "head.json");
  const changedFile = join(dir, "changed.txt");
  writeFileSync(base, lock(basePackages));
  writeFileSync(head, lock(headPackages));
  writeFileSync(changedFile, changed);
  return spawnSync(process.execPath, [script, "--base", base, "--head", head, "--changed", changedFile], {
    encoding: "utf8",
  });
}

function decision(basePackages, headPackages, changed) {
  const result = classify(basePackages, headPackages, changed);
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

describe("dependabot classification", () => {
  const base = { "node_modules/left-pad": entry("left-pad", "1.2.3") };

  it("classifies a patch as auto", () => {
    const head = { "node_modules/left-pad": entry("left-pad", "1.2.4") };
    expect(decision(base, head)).toBe("auto");
  });

  it("classifies a minor as auto", () => {
    const head = { "node_modules/left-pad": entry("left-pad", "1.3.0") };
    expect(decision(base, head)).toBe("auto");
  });

  it("classifies a major as review", () => {
    const head = { "node_modules/left-pad": entry("left-pad", "2.0.0") };
    expect(decision(base, head)).toBe("review");
  });

  it("classifies a 0.x minor as review and a 0.x patch as auto", () => {
    const zero = { "node_modules/left-pad": entry("left-pad", "0.2.3") };
    expect(decision(zero, { "node_modules/left-pad": entry("left-pad", "0.3.0") })).toBe("review");
    expect(decision(zero, { "node_modules/left-pad": entry("left-pad", "0.2.4") })).toBe("auto");
  });

  it("classifies a workflow edit as review", () => {
    expect(decision(base, base, ".github/workflows/check.yml\n")).toBe("review");
  });

  it("classifies a patch mixed with a major as review", () => {
    const before = {
      "node_modules/left-pad": entry("left-pad", "1.2.3"),
      "node_modules/lodash": entry("lodash", "4.17.20"),
    };
    const after = {
      "node_modules/left-pad": entry("left-pad", "1.2.4"),
      "node_modules/lodash": entry("lodash", "5.0.0"),
    };
    expect(decision(before, after)).toBe("review");
  });

  it("classifies a prerelease bump as review", () => {
    const head = { "node_modules/left-pad": entry("left-pad", "1.2.4-beta.1") };
    expect(decision(base, head)).toBe("review");
  });

  it("classifies an install-script bump as review even when the name is not special", () => {
    const before = { "node_modules/plain": entry("plain", "1.2.3", { hasInstallScript: true }) };
    const after = { "node_modules/plain": entry("plain", "1.2.4", { hasInstallScript: true }) };
    expect(decision(before, after)).toBe("review");
  });

  it("classifies an unchanged lockfile as review", () => {
    expect(decision(base, base)).toBe("review");
  });

  it("classifies a real install-script package bump from the lockfile as review", () => {
    const json = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    const key = Object.keys(json.packages).find((name) => json.packages[name].hasInstallScript === true);
    const before = { [key]: json.packages[key] };
    const next = structuredClone(json.packages[key]);
    const from = next.version;
    const bumped = from.replace(/(\d+)$/, (patch) => String(Number(patch) + 1));
    next.version = bumped;
    next.resolved = next.resolved.replace(`-${from}.tgz`, `-${bumped}.tgz`);
    expect(decision(before, { [key]: next })).toBe("review");
  });
});

describe("dependabot workflow", () => {
  const yaml = readFileSync(workflow, "utf8");

  it("is a pull_request workflow with empty top-level permissions", () => {
    expect(yaml).not.toContain("pull_request_target");
    expect(yaml).toMatch(/^on:\n {2}pull_request:\n/m);
    expect(yaml).toMatch(/^permissions: \{\}\n/m);
    expect(yaml).not.toContain("npm ci");
  });

  it("grants write permissions only on the automerge job", () => {
    expect(yaml.match(/contents: write/g)).toHaveLength(1);
    expect(yaml.match(/pull-requests: write/g)).toHaveLength(1);
    const writeAt = yaml.indexOf("contents: write");
    expect(yaml.lastIndexOf("automerge:", writeAt)).toBeGreaterThan(yaml.indexOf("\n  provenance:"));
    expect(yaml.slice(0, yaml.indexOf("\n  automerge:"))).not.toContain("contents: write");
    expect(yaml.slice(0, yaml.indexOf("\n  automerge:"))).toContain("contents: read");
  });

  it("gates auto-merge on the Dependabot author and a passing provenance job", () => {
    expect(yaml).toContain("needs: provenance");
    expect(yaml).toContain(
      "github.actor == 'dependabot[bot]' && github.event.pull_request.user.login == 'dependabot[bot]'",
    );
    expect(yaml).toContain('author=$(gh pr view "$PR_URL" --json author --jq .author.login)');
    expect(yaml).toContain('if [ "$author" != "dependabot[bot]" ]; then');
    expect(yaml).toContain('if [ "$decision" = "auto" ]; then');
    expect(yaml).toContain('gh pr merge --auto --squash "$PR_URL"');
    expect(yaml).toContain("GH_TOKEN: ${{ github.token }}");
    expect(yaml.match(/github\.event\.pull_request\.base\.sha/g)).toHaveLength(2);
    expect(yaml).toContain("--changed");
  });

  it("still satisfies the check.yml sha-pin lint", () => {
    const lint = String.raw`
      if bad=$(grep -nE '^\s*-?\s*uses:\s*\S+@' .github/workflows/*.yml | grep -vE '@[0-9a-f]{40}( |$)'); then
        printf '%s\n' "$bad"
        exit 1
      fi
    `;
    const result = spawnSync("bash", ["-c", lint], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });
});
