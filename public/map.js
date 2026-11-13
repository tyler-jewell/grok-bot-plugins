const pathParts = location.pathname.split("/").filter(Boolean);
const groupToken = pathParts[0] === "g" ? pathParts[1] : "";
const params = new URLSearchParams(location.search);
let memberToken = params.get("member_token") || sessionStorage.getItem(`skiherd:member:${groupToken}`) || "";
const inviteToken = params.get("invite") || "";

const membersEl = document.querySelector("#members");
const countEl = document.querySelector("#count");
const expiryEl = document.querySelector("#expiry");
const statusEl = document.querySelector("#status");
const banner = document.querySelector("#banner");
const joinForm = document.querySelector("#join");
const hostTools = document.querySelector("#host-tools");
const copied = document.querySelector("#copied");

let map;
let markers = new Map();
let socket;
let hidden = document.hidden;
let inviteUrl = "";

function authHeaders() {
  return { authorization: `Bearer ${memberToken}`, "content-type": "application/json" };
}

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 410) {
    banner.hidden = false;
    banner.textContent = "This group has expired. All of its data has been deleted.";
    throw new Error("gone");
  }
  if (!res.ok) throw Object.assign(new Error(data.error || "request failed"), { status: res.status, data });
  return data;
}

function formatExpiry(iso) {
  try {
    return new Date(iso).toLocaleString("en-US", { timeZone: "America/Denver", dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function renderMembers(members) {
  membersEl.replaceChildren();
  for (const m of members) {
    const row = document.createElement("article");
    row.className = "member" + (m.stale ? " stale" : "");
    row.setAttribute("role", "listitem");
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = m.color;
    dot.title = m.name;
    const body = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = m.name;
    const meta = document.createElement("div");
    meta.className = "meta";
    const bits = [];
    if (m.lift_or_trail) bits.push(m.lift_or_trail);
    else if (m.place) bits.push(m.place);
    else if (m.activity) bits.push(m.activity);
    if (m.stale) bits.push("last seen a while ago");
    meta.textContent = bits.join(" · ") || "No fix yet";
    body.append(title, meta);
    row.append(dot, body);
    membersEl.append(row);
  }
  countEl.textContent = `${members.length} of 10`;
}

function upsertMarkers(members) {
  if (!map) return;
  const seen = new Set();
  for (const m of members) {
    if (m.lat == null || m.lon == null) continue;
    seen.add(m.id);
    let marker = markers.get(m.id);
    if (!marker) {
      const el = document.createElement("div");
      el.className = "dot";
      el.style.width = "16px";
      el.style.height = "16px";
      el.style.background = m.color;
      el.setAttribute("role", "img");
      el.setAttribute("aria-label", m.name);
      marker = new maplibregl.Marker({ element: el }).setLngLat([m.lon, m.lat]).addTo(map);
      markers.set(m.id, marker);
    } else {
      marker.setLngLat([m.lon, m.lat]);
    }
  }
  for (const [id, marker] of markers) {
    if (!seen.has(id)) {
      marker.remove();
      markers.delete(id);
    }
  }
}

async function refresh() {
  if (!memberToken || hidden) return;
  const data = await api(`/api/groups/${groupToken}/map`);
  expiryEl.textContent = `Deletes ${formatExpiry(data.expires_at)} MT`;
  renderMembers(data.members);
  upsertMarkers(data.members);
  hostTools.hidden = false;
}

function connectWs() {
  if (!memberToken || hidden) return;
  if (socket) socket.close();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}/g/${groupToken}/ws?member_token=${encodeURIComponent(memberToken)}`);
  socket.addEventListener("message", (event) => {
    if (hidden) return;
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "heartbeat" || msg.type === "joined") refresh().catch(() => {});
    } catch {
      /* ignore */
    }
  });
}

function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: "https://tiles.openfreemap.org/styles/liberty",
    center: [-105.76218, 39.8865],
    zoom: 13.2,
    attributionControl: false,
    cooperativeGestures: true,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
  map.addControl(new maplibregl.AttributionControl({ compact: false, customAttribution: "© OpenStreetMap contributors · OpenFreeMap · Not affiliated with Winter Park Resort" }));
  map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }));
}

async function maybeJoin() {
  if (memberToken) {
    sessionStorage.setItem(`skiherd:member:${groupToken}`, memberToken);
    return true;
  }
  if (!inviteToken) {
    statusEl.textContent = "This map needs a member token or an invite link.";
    return false;
  }
  joinForm.hidden = false;
  return false;
}

joinForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = joinForm.join_name.value.trim();
  try {
    const data = await fetch(`/api/groups/${groupToken}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite_token: inviteToken, display_name: name }),
    }).then((r) => r.json().then((j) => ({ ok: r.ok, j })));
    if (!data.ok) {
      statusEl.textContent = data.j.error || "Could not join.";
      return;
    }
    memberToken = data.j.member_token;
    sessionStorage.setItem(`skiherd:member:${groupToken}`, memberToken);
    const clean = new URL(location.href);
    clean.searchParams.delete("invite");
    clean.searchParams.set("member_token", memberToken);
    history.replaceState({}, "", clean);
    joinForm.hidden = true;
    await refresh();
    connectWs();
  } catch {
    statusEl.textContent = "Could not join this group.";
  }
});

document.querySelector("#make-invite")?.addEventListener("click", async () => {
  copied.textContent = "";
  try {
    const inv = await api(`/api/groups/${groupToken}/invites`, { method: "POST", body: "{}" });
    inviteUrl = inv.invite_url;
    document.querySelector("#copy-invite").hidden = false;
    copied.textContent = "Invite ready. It expires automatically.";
  } catch (err) {
    copied.textContent = err.message || "Could not create an invite.";
  }
});

document.querySelector("#copy-invite")?.addEventListener("click", async () => {
  if (!inviteUrl) return;
  try {
    await navigator.clipboard.writeText(inviteUrl);
    copied.textContent = "Invite link copied.";
  } catch {
    copied.textContent = inviteUrl;
  }
});

document.addEventListener("visibilitychange", () => {
  hidden = document.hidden;
  if (hidden) {
    if (socket) socket.close();
  } else {
    refresh().catch(() => {});
    connectWs();
  }
});

if (!groupToken) {
  statusEl.textContent = "Missing group.";
} else {
  initMap();
  maybeJoin().then((ok) => {
    if (ok) {
      refresh().catch((err) => {
        statusEl.textContent = err.message === "gone" ? "This group has expired." : "Could not load the group.";
      });
      connectWs();
    }
  });
}
