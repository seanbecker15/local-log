const app = require("express")();
const http = require("http").Server(app);
const io = require("socket.io")(http);
const port = process.env.PORT || 3000;
const bodyParser = require("body-parser");
const cors = require('cors');

var corsOptions = {
  origin: ['http://localhost:9000', 'http://192.168.1.125:9922', 'http://192.168.1.110:9000'],
}

app.use(cors(corsOptions));

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
  const body = req.body;
  console.log('Received post to /report: ', body)
  const data = { message: body.message };
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
