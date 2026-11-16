import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Subresource Integrity for third-party assets on the group page (issue #23).
// The page handles member tokens in the URL fragment, so every cdn.jsdelivr.net
// asset must be pinned by hash. This test is offline: it checks the attributes
// exist and are well-formed SHA-384 values; it does not fetch the CDN.
async function cdnTags(): Promise<string[]> {
  const res = await SELF.fetch("https://skiherd.jewell-labs.com/g/x");
  expect(res.status).toBe(200);
  const html = await res.text();
  return (html.match(/<(?:script|link)\b[^>]*>/gi) ?? []).filter((t) => t.includes("cdn.jsdelivr.net"));
}

describe("group page subresource integrity", () => {
  it("loads both MapLibre assets from the pinned CDN version", async () => {
    const tags = await cdnTags();
    expect(tags.filter((t) => /^<script\b/i.test(t) && t.includes("maplibre-gl@5.6.2/dist/maplibre-gl.js"))).toHaveLength(1);
    expect(tags.filter((t) => /^<link\b/i.test(t) && /rel="stylesheet"/.test(t) && t.includes("maplibre-gl@5.6.2/dist/maplibre-gl.css"))).toHaveLength(1);
  });

  it("gives every cdn.jsdelivr.net tag a well-formed sha384 integrity and anonymous crossorigin", async () => {
    const tags = await cdnTags();
    expect(tags.length).toBeGreaterThanOrEqual(2);
    for (const tag of tags) {
      const m = tag.match(/\sintegrity="sha384-([A-Za-z0-9+/]{64})"/);
      expect(m, `missing/malformed integrity on ${tag}`).not.toBeNull();
      // 48 bytes (SHA-384) base64-encodes to exactly 64 chars with no padding.
      expect(atob(m![1]).length).toBe(48);
      expect(tag).toContain('crossorigin="anonymous"');
    }
  });

  it("keeps jsDelivr allowed in the CSP so the pinned assets can load", async () => {
    const res = await SELF.fetch("https://skiherd.jewell-labs.com/g/x");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self' https://cdn.jsdelivr.net");
    expect(csp).toContain("https://cdn.jsdelivr.net");
  });
});
