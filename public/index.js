const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"];
const list = document.getElementById("log");
const filterInput = document.getElementById("filter");
const levelSelect = document.getElementById("level");
const follow = document.getElementById("follow");
const status = document.getElementById("status");
const clearButton = document.getElementById("clear");
const presence = document.getElementById("presence");
const presenceLabel = document.getElementById("presence-label");
const MAX_ENTRIES = 5000;
const RENDER_DELAY_MS = 50;
const entries = [];
let renderTimer = null;
let connection = "connecting";
let shown = 0;
let filterError = false;
let touchY = null;

clearButton.addEventListener("click", () => {
  fetch("/logs", { method: "DELETE" });
});
filterInput.addEventListener("input", scheduleRender);
levelSelect.addEventListener("change", scheduleRender);
follow.addEventListener("change", () => {
  if (follow.checked) scrollToBottom();
  updateStatus();
});
window.addEventListener("wheel", (event) => event.deltaY < 0 && pauseFollow(), { passive: true });
window.addEventListener(
  "touchstart",
  (event) => {
    touchY = event.touches[0]?.clientY ?? null;
  },
  { passive: true },
);
window.addEventListener(
  "touchmove",
  (event) => {
    const nextY = event.touches[0]?.clientY ?? null;
    if (touchY !== null && nextY !== null && nextY > touchY) pauseFollow();
    touchY = nextY;
  },
  { passive: true },
);
window.addEventListener("touchend", () => {
  touchY = null;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement !== filterInput) {
    event.preventDefault();
    filterInput.focus();
  }
  if (
    ![filterInput, levelSelect].includes(document.activeElement) &&
    ["ArrowUp", "Home", "PageUp"].includes(event.key)
  ) {
    pauseFollow();
  }
});

const feed = new EventSource("/events");
feed.addEventListener("entry", (event) => {
  entries.push(JSON.parse(event.data));
  scheduleRender();
});
feed.addEventListener("clear", () => {
  entries.length = 0;
  scheduleRender();
});
feed.addEventListener("presence", (event) => {
  const counts = JSON.parse(event.data);
  const noun = counts.monitors === 1 ? "monitor" : "monitors";
  presenceLabel.textContent = `${counts.monitors} ${noun}`;
  presence.dataset.active = String(counts.monitors > 0);
  presence.title = `${counts.streams} stream · ${counts.waits} waiting · ${counts.viewers} viewing`;
});
feed.onopen = () => {
  connection = "live";
  updateStatus();
};
feed.onerror = () => {
  connection = "disconnected";
  updateStatus();
};

/** Coalesce an SSE replay or live burst instead of rebuilding the whole DOM for every entry. */
function scheduleRender() {
  if (renderTimer !== null) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render();
  }, RENDER_DELAY_MS);
}

function render() {
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  let pattern = null;
  filterError = false;
  try {
    pattern = filterInput.value ? new RegExp(filterInput.value, "i") : null;
    filterInput.setCustomValidity("");
  } catch {
    filterError = true;
    filterInput.setCustomValidity("invalid regular expression");
  }
  const minRank = LEVELS.indexOf(levelSelect.value);
  const fragment = document.createDocumentFragment();
  shown = 0;
  for (const entry of entries) {
    if (filterError) continue;
    if (LEVELS.indexOf(entry.level) < minRank) continue;
    const searchable = `${entry.level} ${entry.source ?? ""} ${entry.text}`;
    if (pattern && !pattern.test(searchable)) continue;
    fragment.appendChild(row(entry));
    shown++;
  }
  list.replaceChildren(fragment);
  updateStatus();
  if (follow.checked) scrollToBottom();
}

function updateStatus() {
  const state = filterError ? "invalid filter" : connection;
  const paused = !follow.checked && entries.length > 0 ? " · paused" : "";
  status.textContent = `${state}${paused} · ${shown}/${entries.length}`;
  status.dataset.connection = filterError ? "error" : connection;
  list.dataset.empty = filterError
    ? "Invalid regular expression"
    : entries.length > 0
      ? "No logs match this filter"
      : connection === "disconnected"
        ? "Disconnected — retrying…"
        : "Waiting for logs…";
}

function scrollToBottom() {
  window.scrollTo(0, document.body.scrollHeight);
}

function pauseFollow() {
  if (!follow.checked) return;
  follow.checked = false;
  updateStatus();
}

function row(entry) {
  const li = document.createElement("li");
  li.dataset.level = entry.level;
  li.title = entry.ts;

  const time = document.createElement("span");
  time.className = "time";
  time.textContent = entry.ts.slice(11, 23);

  const level = document.createElement("span");
  level.className = "level";
  level.textContent = entry.level.toUpperCase();

  const source = document.createElement("span");
  source.className = "source";
  source.textContent = entry.source ?? "—";

  const message = document.createElement("span");
  message.className = "message";
  message.textContent = entry.text;

  li.append(time, level, source, message);
  if (entry.meta) {
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = JSON.stringify(entry.meta);
    li.append(meta);
  }
  return li;
}

updateStatus();
