const socket = io();

const form = document.getElementById("form");
const messageList = document.getElementById("message-list");

socket.on("message", function ({ message, ts, level }) {
  if (typeof message !== "string") {
    return;
  }

  // Prefer the server's ingest time. Rendering time drifts per client, so the
  // same entry used to show a different timestamp in every open tab.
  const stamp = ts || new Date().toISOString();

  message.split("\n").forEach((text) => {
    const messagesItem = document.createElement("li");
    messagesItem.textContent = `[${stamp}] ${text}`;
    messagesItem.className = "p-list__item";
    if (level && level !== "log") {
      messagesItem.dataset.level = level;
    }
    messageList.appendChild(messagesItem);
  });

  window.scrollTo(0, document.body.scrollHeight);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const message = new FormData(form).get("message");
  if (message) {
    socket.emit("client-message", {
      message: new FormData(form).get("message"),
    });
  }
});

messageList.style.maxHeight = window.innerHeight - form.clientHeight;
