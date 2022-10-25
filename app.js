const app = require("express")();
const http = require("http").Server(app);
const io = require("socket.io")(http);
const port = process.env.PORT || 3000;
const bodyParser = require("body-parser");

app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

io.on("connection", (socket) => {
  console.log("A user connected");

  socket.on("client-message", (data) => {
    sendGlobalMessage(data);
  });
});

app.post("/report", (req, res) => {
  const data = { message: req.body.message };
  sendGlobalMessage(data);
  res.status(200);
  res.send(data);
});

http.listen(port, "0.0.0.0", () => {
  console.log(`Server running at http://localhost:${port}/`);
});

// #region helpers

function sendGlobalMessage(msg) {
  io.emit("message", msg);
}

// #endregion
