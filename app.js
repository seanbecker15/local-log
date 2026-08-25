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
  origin: ["https://example.com"],
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use("/public", express.static(path.join(__dirname, "./public")));

if (process.env.NODE_ENV !== "production") {
  app.use((_, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    next();
  });

  const swaggerJSDoc = require("swagger-jsdoc");
  const swaggerUi = require("swagger-ui-express");
  const swaggerOptions = {
    swaggerDefinition: {
      info: {
        title: "OP Logger",
        version: "1.0.0",
        description: "Alows on-prem (local) logging via REST and Socket Events",
      },
      host: `localhost:${PORT}`,
      basePath: "/",
    },
    apis: ["./app.js"],
  };
  const swaggerSpec = swaggerJSDoc(swaggerOptions);
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
}

app.use(cors(CORS_OPTIONS));

app.use(bodyParser.json());

const BUFFER_SIZE = Number(process.env.LOG_BUFFER_SIZE) || 5000;
const MAX_WAIT_MS = Number(process.env.LOG_MAX_WAIT_MS) || 60000;
const LEVELS = ["log", "info", "warn", "error", "debug"];

let entries = [];
let seq = 0;

// Resolvers for in-flight long-polls, woken by recordEntry.
const waiters = new Set();

try {
  entries = JSON.parse(readMessagesFile()).filter(
    (entry) => entry && typeof entry.seq === "number",
  );
  seq = entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
} catch {
  console.warn("Unable to read messages file at startup");
}

// Flush periodically. Previously this fired once, 30s after boot.
setInterval(() => {
  writeMessagesFile(JSON.stringify(entries));
}, 30000).unref();

io.on("connection", (socket) => {
  console.log("user connected via socket");

  socket.on("client-message", (data) => {
    recordEntry(data?.message);
  });

  entries.forEach((entry) => {
    socket.emit("message", toSocketMessage(entry));
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
    const { message, level } = body;
    recordEntry(message, level);
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
    const identity = Array.isArray(session) ? session.join(", ") : "";
    const lines = logs.reduce((acc, log) => {
      const parsedLog = JSON.parse(log);
      const { type: level, item } = parsedLog;
      const message = JSON.stringify(item);
      recordEntry(message, level, identity);
      return `${acc}${JSON.stringify({ level, message, identity })}\n`;
    }, "");
    updateLogFile(lines);
    console.log(`${new Date().getTime()} [POST] /log - status (200)`);
    res.status(200);
    res.send({ message: "log processed" });
  } catch {
    console.error(`${new Date().getTime()} [POST] /log - status (400)`);
    res.status(400);
    res.send({ message: "log not processed" });
  }
});

/**
 * @openapi
 *
 * /logs:
 *   get:
 *     summary: Reads buffered log entries, newest last
 *     produces:
 *       - "application/json"
 *     parameters:
 *       - name: after
 *         in: query
 *         description: Only return entries with a seq greater than this
 *         type: integer
 *       - name: level
 *         in: query
 *         type: string
 *       - name: grep
 *         in: query
 *         description: Case-insensitive regular expression matched against text
 *         type: string
 *       - name: limit
 *         in: query
 *         type: integer
 *       - name: wait
 *         in: query
 *         description: Milliseconds to hold the request open awaiting a match
 *         type: integer
 *     responses:
 *       200:
 *         description: OK
 *       400:
 *         description: FAIL
 */
app.get("/logs", async (req, res) => {
  let filter;
  try {
    filter = parseFilter(req.query);
  } catch (err) {
    res.status(400);
    return res.send({ message: err.message });
  }

  const wait = Math.min(Number(req.query.wait) || 0, MAX_WAIT_MS);
  let matches = queryEntries(filter);
  if (matches.length === 0 && wait > 0) {
    matches = await waitForEntries(filter, wait);
  }

  res.send({
    cursor: seq,
    count: matches.length,
    timed_out: matches.length === 0 && wait > 0,
    entries: matches,
  });
});

/**
 * @openapi
 *
 * /logs:
 *   delete:
 *     summary: Discards buffered log entries
 *     produces:
 *       - "application/json"
 *     responses:
 *       200:
 *         description: OK
 */
app.delete("/logs", (req, res) => {
  const cleared = entries.length;
  // seq keeps counting so stale cursors never re-read a recycled number.
  entries = [];
  res.send({ cursor: seq, cleared });
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
 * Normalizes a message, appends it to the buffer, broadcasts it, and wakes any
 * long-polls waiting on new entries.
 *
 * @param {*} message the logged value. Non-strings are JSON encoded.
 * @param {string} [level] one of LEVELS. Anything else is recorded as "log".
 * @param {string} [identity] the reporting client, when known.
 * @return {object} the stored entry.
 */
function recordEntry(message, level, identity) {
  const text = typeof message === "string" ? message : JSON.stringify(message);
  const entry = {
    seq: ++seq,
    ts: new Date().toISOString(),
    level: LEVELS.includes(level) ? level : "log",
    text: text ?? "",
  };
  if (identity) {
    entry.identity = identity;
  }

  entries.push(entry);
  if (entries.length > BUFFER_SIZE) {
    entries.splice(0, entries.length - BUFFER_SIZE);
  }

  sendGlobalMessage(toSocketMessage(entry));
  // Snapshot and clear before waking: a waiter whose filter this entry does not
  // match re-registers during the wake, and must survive into the next round.
  const pending = Array.from(waiters);
  waiters.clear();
  pending.forEach((wake) => wake());
  return entry;
}

/**
 * @param {object} entry a stored entry.
 * @return {object} the socket payload. `message` is kept for existing clients.
 */
function toSocketMessage(entry) {
  return {
    message: entry.text,
    seq: entry.seq,
    ts: entry.ts,
    level: entry.level,
  };
}

/**
 * @param {object} query the raw request query.
 * @return {object} a validated filter.
 * @throws {Error} if a parameter is unusable.
 */
function parseFilter(query) {
  const { after, level, grep, limit } = query;
  if (level && !LEVELS.includes(level)) {
    throw new Error(`level must be one of: ${LEVELS.join(", ")}`);
  }
  let pattern = null;
  if (grep) {
    try {
      pattern = new RegExp(grep, "i");
    } catch {
      throw new Error(`grep is not a valid regular expression: ${grep}`);
    }
  }
  return {
    after: Number(after) || 0,
    level: level || null,
    pattern,
    limit: Math.min(Number(limit) || 200, 1000),
  };
}

/**
 * @param {object} filter a filter from parseFilter.
 * @return {Array<object>} matching entries, oldest first, capped at the limit.
 */
function queryEntries({ after, level, pattern, limit }) {
  const matches = entries.filter(
    (entry) =>
      entry.seq > after &&
      (!level || entry.level === level) &&
      (!pattern || pattern.test(entry.text)),
  );
  return matches.slice(-limit);
}

/**
 * Resolves as soon as an entry matches the filter, or with an empty array once
 * waitMs elapses. Re-checks on every new entry, since an arrival may not match.
 *
 * @param {object} filter a filter from parseFilter.
 * @param {number} waitMs how long to hold the request open.
 * @return {Promise<Array<object>>} matching entries, possibly empty.
 */
function waitForEntries(filter, waitMs) {
  const deadline = Date.now() + waitMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const matches = queryEntries(filter);
      if (matches.length > 0) {
        return resolve(matches);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return resolve([]);
      }
      const timer = setTimeout(() => {
        waiters.delete(wake);
        attempt();
      }, remaining);
      const wake = () => {
        clearTimeout(timer);
        attempt();
      };
      waiters.add(wake);
    };
    attempt();
  });
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
