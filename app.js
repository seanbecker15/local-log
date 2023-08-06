const express = require("express");
const { Server } = require("http");
const bodyParser = require("body-parser");
const socketio = require("socket.io");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const server = new Server(app);
const io = socketio(server);

const { appendFileSync, readFileSync, writeFileSync } = fs;

const PORT = process.env.PORT || 3000;
const CORS_OPTIONS = {
  origin: [
    "http://localhost:3000",
    "http://localhost:8080",
    "http://localhost:9000",
    "http://192.168.1.125:9922",
    "http://192.168.1.110:9000",
  ],
};

app.use("/public", express.static(path.join(__dirname, "./public")));

app.use(cors(CORS_OPTIONS));

app.use(bodyParser.json());

let messages = [];

try {
  messages = JSON.parse(readMessagesFile());
} catch {
  console.warn("Unable to read messages file at startup", e);
}

setTimeout(() => {
  writeMessagesFile(JSON.stringify(messages));
}, 30000);

io.on("connection", (socket) => {
  console.log("user connected via socket");

  socket.on("client-message", (data) => {
    sendGlobalMessage(data);
    messages.push(data);
  });

  messages.forEach((message) => {
    socket.emit("message", message);
  });
});

/**
 * @openapi
 *
 * /:
 *   get:
 *     summary: Gets message UI
 *     produces:
 *       - "text/html"
 *     responses:
 *       200:
 *         description: OK
 */
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

/**
 * @openapi
 *
 * /message:
 *   post:
 *     summary: Submits a message
 *     produces:
 *       - "application/json"
 *     parameters:
 *       - name: data
 *         in: body
 *         schema:
 *           properties:
 *             message: { type: string }
 *     responses:
 *       200:
 *         description: OK
 *       400:
 *         description: FAIL
 */
app.post("/message", (req, res) => {
  try {
    const body = req.body;
    const { message } = body;
    sendGlobalMessage({ message });
    messages.push(message);
    console.log(`${new Date().getTime()} [POST] /message - status (200)`);
    res.status(200);
    res.send({ message: "message processed", content: message });
  } catch {
    console.log(`${new Date().getTime()} [POST] /message - status (400)`);
    res.status(400);
    res.send({ message: "message not processed" });
  }
});

/**
 * @openapi
 *
 * /log:
 *   post:
 *     summary: Logs a message
 *     produces:
 *       - "application/json"
 *     parameters:
 *       - name: data
 *         in: body
 *         schema:
 *           properties:
 *             message: { type: string }
 *     responses:
 *       200:
 *         description: OK
 *       400:
 *         description: FAIL
 */
app.post("/log", (req, res) => {
  try {
    const body = req.body;
    const { logs, session } = body;
    const lines = logs.reduce((acc, log) => {
      const parsedLog = JSON.parse(log);
      const { type: level, item } = parsedLog;
      const row = JSON.stringify({
        level,
        message: JSON.stringify(item),
        identity: session.join(", "),
      });
      return `${acc}${row}\n`;
    }, "");
    updateLogFile(lines);
    sendGlobalMessage({ message: lines });
    console.log(`${new Date().getTime()} [POST] /log - status (200)`);
    res.status(200);
    res.send({ message: "log processed" });
  } catch {
    console.error(`${new Date().getTime()} [POST] /log - status (400)`);
    res.status(400);
    res.send({ message: "log not processed" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running at http://localhost:${PORT}/`);
});

/**
 * Emits a message to all connected clients using Socket.io.
 *
 * @param {{message: string}} messageObj the message object we send to all connected clients.
 */
function sendGlobalMessage(messageObj) {
  io.emit("message", messageObj);
}

/**
 *
 * @param {string} text string content to append to the out.log file.
 */
function updateLogFile(text) {
  const filepath = path.resolve(__dirname, "out.log");
  appendFileSync(filepath, text);
}

/**
 * @param {string} text string content to store in the messages.json file.
 */
function writeMessagesFile(text) {
  const filepath = path.resolve(__dirname, "messages.json");
  writeFileSync(filepath, text, { encoding: "utf-8" });
}

/**
 * @return {string} string content of the messages.json file.
 */
function readMessagesFile() {
  const filepath = path.resolve(__dirname, "messages.json");
  return readFileSync(filepath, { encoding: "utf-8" });
}
