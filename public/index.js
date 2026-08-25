const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"];
const list = document.getElementById("log");
const filterInput = document.getElementById("filter");
const levelSelect = document.getElementById("level");
const follow = document.getElementById("follow");
const status = document.getElementById("status");
const entries = [];

document.getElementById("clear").addEventListener("click", () => {
  fetch("/logs", { method: "DELETE" });
});
filterInput.addEventListener("input", render);
levelSelect.addEventListener("change", render);

const feed = new EventSource("/events");
feed.addEventListener("entry", (event) => {
  entries.push(JSON.parse(event.data));
  if (entries.length > 5000) entries.shift();
  render();
});
feed.addEventListener("clear", () => {
  entries.length = 0;
  render();
});
feed.onopen = () => {
  status.textContent = "live";
};
feed.onerror = () => {
  status.textContent = "disconnected";
};

function render() {
  let pattern = null;
  try {
    pattern = filterInput.value ? new RegExp(filterInput.value, "i") : null;
    filterInput.setCustomValidity("");
  } catch {
    filterInput.setCustomValidity("invalid regex");
  }
  const minRank = LEVELS.indexOf(levelSelect.value);
  const fragment = document.createDocumentFragment();
  let shown = 0;
  for (const entry of entries) {
    if (LEVELS.indexOf(entry.level) < minRank) continue;
    if (pattern && !pattern.test(entry.text)) continue;
    fragment.appendChild(row(entry));
    shown++;
  }
  list.replaceChildren(fragment);
  status.textContent = `${shown}/${entries.length}`;
  if (follow.checked) window.scrollTo(0, document.body.scrollHeight);
}

function row(entry) {
  const li = document.createElement("li");
  li.dataset.level = entry.level;
  const time = document.createElement("span");
  time.className = "src";
  time.textContent = `${entry.ts.slice(11, 23)} ${entry.level.toUpperCase().padEnd(5)}`;
  li.append(time);
  if (entry.source) {
    const src = document.createElement("span");
    src.className = "src";
    src.textContent = entry.source;
    li.append(src);
  }
  li.append(document.createTextNode(entry.text));
  if (entry.meta) {
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = JSON.stringify(entry.meta);
    li.append(meta);
  }
  return li;
}
