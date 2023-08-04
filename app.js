const app = require("express")();
const http = require("http").Server(app);
const io = require("socket.io")(http);
const port = process.env.PORT || 3000;
const bodyParser = require("body-parser");
const cors = require("cors");
const { appendFileSync } = require("fs");
const path = require("path");

var corsOptions = {
  origin: [
    "http://localhost:3000",
    "http://localhost:8080",
    "http://localhost:9000",
    "http://192.168.1.125:9922",
    "http://192.168.1.110:9000",
  ],
};

app.use(cors(corsOptions));

app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

io.on("connection", (socket) => {
  console.log("user connected via socket");

  socket.on("client-message", (data) => {
    sendGlobalMessage(data);
  });
});

/**
 * @openapi
 *
 * /report:
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
 */
app.post("/report", (req, res) => {
  const body = req.body;

  console.log("Received post to /report");

  const data = { message: body.message };

  sendGlobalMessage(data);

  res.status(200);
  res.send(data);
});

app.post("/log", (req, res) => {
  try {
    const body = req.body;
    const { logs, session } = body;
    let updates = logs.reduce((acc, log) => {
      const parsedLog = JSON.parse(log);
      const { type: level, item } = parsedLog;
      const json = {
        level,
        message: JSON.stringify(item),
        identity: session.join(", "),
      };
      return `${acc}${JSON.stringify(json)}\n`;
    }, "");

    updateLogFile(updates);
    sendGlobalMessage({ message: updates });
    console.log(`${new Date().getTime()} [POST] /log - status (200)`);
    res.status(200);
    res.send({ message: 'log processed' });
  } catch {
    console.error(`${new Date().getTime()} [POST] /log - status (400)`);
    res.status(400);
    res.send({ message: 'log not processed' });
  }
});

http.listen(port, "0.0.0.0", () => {
  console.log(`Server running at http://localhost:${port}/`);
});

// #region helpers

function sendGlobalMessage(msg) {
  io.emit("message", msg);
}

function updateLogFile(text) {
  const filepath = path.resolve(__dirname, "out.log");
  appendFileSync(filepath, text);
}

// #endregion
