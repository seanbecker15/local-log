const app = require("express")();
const http = require("http"); 
const swaggerJSDoc = require("swagger-jsdoc");
const swaggerTools = require("swagger-tools");

const fs = require("fs");

const swaggerPort = process.env.PORT || 8080;
const messagePort = 3000;

const swaggerOptions = {
  swaggerDefinition: {
    info: {
      title: "OP Logger",
      version: "1.0.0",
      description: "Alows on-prem (local) logging via REST and Socket Events",
    },
    host: `localhost:${messagePort}`,
    basePath: "/",
  },
  apis: ["./app.js"],
};

const swaggerSpec = swaggerJSDoc(swaggerOptions);

fs.writeFileSync("./api-docs.json", JSON.stringify(swaggerSpec));

swaggerTools.initializeMiddleware(swaggerSpec, function (middleware) {
  // Serve the Swagger documents and Swagger UI
  app.use(middleware.swaggerUi({ swaggerUi: "/" }));

  // Start the server
  http.createServer(app).listen(swaggerPort, function () {
    console.log(
      "Your server is listening on port %d (http://localhost:%d)",
      swaggerPort,
      swaggerPort,
    );
  });
});
