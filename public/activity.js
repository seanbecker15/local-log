const list = document.getElementById("deliveries");
const follow = document.getElementById("follow");
const status = document.getElementById("status");
const MAX_DELIVERIES = 200;
let connection = "connecting";

document.getElementById("clear").addEventListener("click", () => {
  fetch("/activity", { method: "DELETE" });
});

window.addEventListener(
  "wheel",
  (event) => {
    if (event.deltaY < 0) follow.checked = false;
  },
  { passive: true },
);

const feed = new EventSource("/activity-events");
feed.addEventListener("presence", (event) => renderPresence(JSON.parse(event.data)));
feed.addEventListener("delivery", (event) => {
  list.append(row(JSON.parse(event.data)));
  while (list.children.length > MAX_DELIVERIES) list.firstElementChild.remove();
  setStatus(connection);
  if (follow.checked) window.scrollTo(0, document.body.scrollHeight);
});
feed.addEventListener("clear", () => {
  list.replaceChildren();
  setStatus(connection);
});
feed.onopen = () => setStatus("live");
feed.onerror = () => setStatus("disconnected");

follow.addEventListener("change", () => {
  if (follow.checked) window.scrollTo(0, document.body.scrollHeight);
});

function renderPresence(counts) {
  document.getElementById("monitors").textContent = counts.monitors;
  document.getElementById("monitor-label").textContent =
    counts.monitors === 1 ? "active monitor" : "active monitors";
  document.getElementById("streams").textContent = counts.streams;
  document.getElementById("waits").textContent = counts.waits;
  document.getElementById("viewers").textContent = counts.viewers;
}

function setStatus(nextConnection) {
  connection = nextConnection;
  status.textContent = `${connection} · ${list.children.length} deliveries`;
  status.dataset.connection = connection;
}

function row(delivery) {
  const item = document.createElement("li");
  item.dataset.channel = delivery.channel;

  const heading = document.createElement("div");
  heading.className = "delivery-heading";
  heading.append(
    field(delivery.ts.slice(11, 23), "time"),
    field(delivery.channel.toUpperCase(), "delivery-channel"),
    field(delivery.tool, "delivery-tool"),
    field(delivery.client, "delivery-client"),
  );

  const args = document.createElement("code");
  args.className = "delivery-args";
  args.textContent = Object.keys(delivery.args).length > 0 ? JSON.stringify(delivery.args) : "{}";

  const payload = document.createElement("pre");
  payload.textContent = delivery.text;
  if (delivery.error) payload.dataset.error = "true";

  item.append(heading, args, payload);
  return item;
}

function field(text, className) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}
