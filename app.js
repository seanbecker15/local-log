const app = require("express")();
const http = require("http").Server(app);
const io = require("socket.io")(http);
const port = process.env.PORT || 3000;
const bodyParser = require("body-parser");

app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

app.post("/report", (req, res) => {
  io.emit("err", req.body.msg);
  res.status(200);
  res.send(null);
});

http.listen(port, "0.0.0.0", () => {
  console.log(`Socket.IO server running at http://localhost:${port}/`);
});
