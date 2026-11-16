// Print the last Durable Object migration tag staging will apply.
import { readFileSync } from "node:fs";
import { parseJsonc } from "./lib/jsonc.mjs";

const config = parseJsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const migrations = config?.env?.staging?.migrations;
if (!Array.isArray(migrations) || migrations.length === 0) {
  console.error("staging migrations are missing");
  process.exit(1);
}
const tag = migrations[migrations.length - 1]?.tag;
if (typeof tag !== "string" || tag === "") {
  console.error("staging migration tag is missing");
  process.exit(1);
}
console.log(tag);
