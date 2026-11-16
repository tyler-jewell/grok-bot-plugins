// Fail closed before any Cloudflare deploy. Never prints the account id or a token.
const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

const account = flag("--account-id");
const tokenPresent = flag("--token-present");

if (typeof account !== "string" || account.trim() === "") {
  console.error("Cloudflare account id is not configured");
  process.exit(1);
}
if (tokenPresent !== "1") {
  console.error("Cloudflare API token is not configured");
  process.exit(1);
}
