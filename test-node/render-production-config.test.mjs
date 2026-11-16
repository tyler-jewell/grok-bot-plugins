import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../scripts/render-production-config.mjs", import.meta.url));
const VALID = "groups.example.com";

function run(args = [], env = {}) {
  const childEnv = { ...process.env, ...env };
  if (!Object.prototype.hasOwnProperty.call(env, "PRODUCTION_HOSTNAME")) delete childEnv.PRODUCTION_HOSTNAME;
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: childEnv });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function expectRejected(result, message) {
  expect(result.code).toBe(1);
  expect(result.err).toContain(message);
  expect(result.out).toBe("");
}

describe("render-production-config.mjs rejects a bad hostname", () => {
  it("rejects an empty hostname argument", () => {
    expectRejected(run(["--hostname", ""]), "production hostname is empty");
  });

  it("rejects an unset hostname", () => {
    expectRejected(run([]), "production hostname is empty");
  });

  it("rejects an empty PRODUCTION_HOSTNAME", () => {
    expectRejected(run([], { PRODUCTION_HOSTNAME: "" }), "production hostname is empty");
  });

  it("rejects a whitespace-only hostname", () => {
    expectRejected(run(["--hostname", "   "]), "whitespace");
  });

  it("rejects a hostname with surrounding whitespace", () => {
    expectRejected(run(["--hostname", ` ${VALID} `]), "whitespace");
  });

  it("rejects a scheme", () => {
    expectRejected(run(["--hostname", `https://${VALID}`]), "scheme");
  });

  it("rejects a path", () => {
    expectRejected(run(["--hostname", `${VALID}/mcp`]), "path");
  });

  it("rejects a wildcard", () => {
    expectRejected(run(["--hostname", `*.${VALID}`]), "wildcard");
  });

  it("rejects the staging hostname", () => {
    expectRejected(run(["--hostname", "skiherd-groups.jewell-labs.com"]), "staging hostname");
  });

  it("rejects a port", () => {
    expectRejected(run(["--hostname", `${VALID}:443`]), "plain hostname");
  });
});

describe("render-production-config.mjs renders one production route", () => {
  it("uses --hostname", () => {
    const result = run(["--hostname", VALID]);
    expect(result.code).toBe(0);
    const rendered = JSON.parse(result.out);
    expect(rendered.routes).toEqual([{ pattern: VALID, custom_domain: true }]);
    expect(rendered.route).toBeUndefined();
    expect(rendered.env).toBeUndefined();
    expect(rendered.vars.PUBLIC_BASE_URL).toBe(`https://${VALID}`);
    expect(rendered.name).toBe("skiherd-groups");
    expect(JSON.stringify(rendered).match(/"custom_domain":true/g)).toEqual(['"custom_domain":true']);
    expect(rendered.account_id).toBeUndefined();
  });

  it("uses PRODUCTION_HOSTNAME when --hostname is omitted", () => {
    const result = run([], { PRODUCTION_HOSTNAME: VALID });
    expect(result.code).toBe(0);
    const rendered = JSON.parse(result.out);
    expect(rendered.routes).toEqual([{ pattern: VALID, custom_domain: true }]);
  });

  it("does not fall through to PRODUCTION_HOSTNAME when --hostname is empty", () => {
    expectRejected(run(["--hostname", ""], { PRODUCTION_HOSTNAME: VALID }), "production hostname is empty");
  });
});
