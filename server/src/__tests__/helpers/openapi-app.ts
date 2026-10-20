import { createServer } from "node:http";
import express from "express";
import { onTestFinished } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { openApiRoutes } from "../../routes/openapi.js";

export async function createOpenApiTestApp() {
  const app = express();
  app.use("/api", openApiRoutes());
  app.use(errorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return server;
}
