const socket = io();

const form = document.getElementById("form");
const messageList = document.getElementById("message-list");

socket.on("message", function ({ message }) {
  if (typeof message !== "string") {
    return;
  }

  message.split("\n").forEach((text) => {
    const messagesItem = document.createElement("li");
    messagesItem.textContent = `[${new Date().toISOString()}] ${text}`;
    messagesItem.className = "p-list__item";
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
