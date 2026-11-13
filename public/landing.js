const form = document.querySelector("#create");
const status = document.querySelector("#status");

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button");
  const name = form.host_name.value.trim();
  if (!name) return;
  button.disabled = true;
  status.textContent = "Creating group…";
  try {
    const res = await fetch("/api/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host_name: name }),
    });
    const data = await res.json();
    if (!res.ok) {
      status.textContent = data.error || "Could not create a group.";
      button.disabled = false;
      return;
    }
    const target = data.member_map_url || `${data.host_url}#t=${encodeURIComponent(data.member_token)}`;
    const url = new URL(target, location.origin);
    location.assign(`${url.pathname}${url.search}${url.hash}`);
  } catch {
    status.textContent = "Network error. Try again.";
    button.disabled = false;
  }
});
