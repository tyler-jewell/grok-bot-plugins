import { readFileSync } from "node:fs";

const file = process.argv[2];
if (file === undefined || file === "") {
  console.error("usage: node scripts/assert-no-uncaught.mjs <log>");
  process.exit(2);
}
const text = readFileSync(file, "utf8");
if (text.includes("uncaught exception")) {
  console.error("uncaught exception in test output");
  process.exit(1);
}
