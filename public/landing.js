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
    const url = new URL(data.host_url, location.origin);
    url.searchParams.set("member_token", data.member_token);
    location.assign(`${url.pathname}${url.search}`);
  } catch {
    status.textContent = "Network error. Try again.";
    button.disabled = false;
  }
});
