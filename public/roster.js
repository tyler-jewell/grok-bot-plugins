const rosters = new WeakMap();

export function statusText(member) {
  const bits = [];
  if (member.lift_or_trail) bits.push(member.lift_or_trail);
  else if (member.place) bits.push(member.place);
  else if (member.activity) bits.push(member.activity);
  if (member.stale) bits.push("last seen a while ago");
  return bits.join(" · ") || "No fix yet";
}

/** Update the roster in place so a live region announces only the rows that changed. */
export function renderMembers(membersEl, members) {
  let rows = rosters.get(membersEl);
  if (rows === undefined) {
    rows = new Map();
    rosters.set(membersEl, rows);
  }
  const seen = new Set();
  for (const member of members) {
    seen.add(member.id);
    let row = rows.get(member.id);
    const text = statusText(member);
    if (row === undefined) {
      row = document.createElement("article");
      row.className = "member";
      row.setAttribute("role", "listitem");
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.setAttribute("aria-hidden", "true");
      const body = document.createElement("div");
      const title = document.createElement("strong");
      const meta = document.createElement("div");
      meta.className = "meta";
      body.append(title, meta);
      row.append(dot, body);
      membersEl.append(row);
      rows.set(member.id, row);
    }
    row.classList.toggle("stale", member.stale === true);
    const dot = row.querySelector(".dot");
    if (dot !== null) dot.style.background = member.color;
    const title = row.querySelector("strong");
    if (title !== null && title.textContent !== member.name) title.textContent = member.name;
    const meta = row.querySelector(".meta");
    if (meta !== null && meta.textContent !== text) meta.textContent = text;
  }
  for (const [id, row] of rows) {
    if (!seen.has(id)) {
      row.remove();
      rows.delete(id);
    }
  }
}

/** Map pin. Hidden from assistive tech; the roster is the accessible list. */
export function markerElement(member) {
  const el = document.createElement("div");
  el.className = "dot";
  el.style.width = "16px";
  el.style.height = "16px";
  el.style.background = member.color;
  el.setAttribute("aria-hidden", "true");
  return el;
}
