import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { markerElement, renderMembers } from "../public/roster.js";

const require = createRequire(import.meta.url);
const axeSource = require("axe-core").source;
const root = new URL("../public/", import.meta.url);

function page(name) {
  const html = readFileSync(new URL(name, root), "utf8");
  const dom = new JSDOM(html, {
    url: "https://groups.example.com/",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
  // axe looks up window/document on the realm that loaded it. Evaluating it
  // inside the jsdom window is what makes axe.run see this document.
  new Script(axeSource).runInContext(dom.getInternalVMContext());
  return dom;
}

async function serious(dom) {
  const results = await dom.window.axe.run(dom.window.document, {
    // Colour contrast needs a layout engine. That is part 2 (issue #29).
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.filter((row) => row.impact === "serious" || row.impact === "critical");
}

describe("static page accessibility", () => {
  // /g/x is group.html. The Worker serves that file for every group path.
  const pages = [
    ["/", "index.html"],
    ["/g/x", "group.html"],
    ["/privacy.html", "privacy.html"],
    ["/terms.html", "terms.html"],
  ];

  for (const [route, file] of pages) {
    it(`axe finds no serious or critical issue on ${route}`, async () => {
      const dom = page(file);
      const violations = await serious(dom);
      expect(violations.map((row) => `${row.id}: ${row.help}`)).toEqual([]);
      dom.window.close();
    });
  }

  it("the group page announces roster changes and hides the map pins", () => {
    const dom = page("group.html");
    const members = dom.window.document.querySelector("#members");
    expect(members.getAttribute("aria-live")).toBe("polite");
    expect(members.getAttribute("aria-relevant")).toBe("additions text");
    globalThis.document = dom.window.document;
    const first = [
      { id: "a", name: "Alex", color: "#111", lift_or_trail: "Cranmer", stale: false },
      { id: "b", name: "Sam", color: "#222", place: "Village", stale: false },
    ];
    renderMembers(members, first);
    const alex = members.querySelector("article");
    const alexMeta = alex.querySelector(".meta");
    renderMembers(members, [
      { id: "a", name: "Alex", color: "#111", lift_or_trail: "Jack Kendrick", stale: false },
      { id: "b", name: "Sam", color: "#222", place: "Village", stale: false },
    ]);
    expect(members.querySelector("article")).toBe(alex);
    expect(alexMeta.textContent).toBe("Jack Kendrick");
    expect(members.querySelectorAll("article")).toHaveLength(2);
    const dot = alex.querySelector(".dot");
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    const pin = markerElement({ id: "a", name: "Alex", color: "#111" });
    expect(pin.getAttribute("aria-hidden")).toBe("true");
    expect(pin.getAttribute("tabindex")).toBeNull();
    expect(pin.getAttribute("role")).toBeNull();
    dom.window.close();
  });
});

describe("keyboard focus styles", () => {
  it("links, buttons, and inputs show an outline on focus-visible", () => {
    const css = readFileSync(new URL("styles.css", root), "utf8");
    expect(css).toMatch(/a:focus-visible,\s*button:focus-visible,\s*input:focus-visible\s*\{[^}]*outline:\s*3px solid/s);
    for (const file of ["index.html", "group.html", "privacy.html", "terms.html"]) {
      const html = readFileSync(new URL(file, root), "utf8");
      const dom = new JSDOM(html);
      for (const el of dom.window.document.querySelectorAll("a, button, input")) {
        expect(el.getAttribute("tabindex"), `${file} ${el.outerHTML}`).not.toBe("-1");
      }
      dom.window.close();
    }
  });
});
