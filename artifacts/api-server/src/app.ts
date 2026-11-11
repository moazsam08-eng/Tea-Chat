import express, { type Express } from "express";
import cors from "cors";
import router from "./routes";
import { maintenanceGate } from "./routes/maintenance";

const app: Express = express();

// Use the Workers runtime logger instead of pino-http, whose Node internals
// are not compatible with the Cloudflare Workers bundle.
app.use((req, _res, next) => {
  console.info(`[api] ${req.method} ${req.path}`);
  next();
});

app.use(cors());
// Preserve the exact raw body for Stream's signed before-message-send webhook.
app.use("/api/webhooks/stream/before-message-send", express.raw({ type: "application/json", limit: "1mb" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", maintenanceGate, router);

// Express 5 forwards rejected async route handlers here. Without this
// middleware, its default handler returns an HTML 500 page and hides the
// useful exception details from our application logs.
app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error("[api] Unhandled route exception", {
    method: req.method,
    path: req.path,
    name: err.name,
    message: err.message,
    stack: err.stack,
  });

  if (res.headersSent) {
    next(error);
    return;
  }

  res.status(500).json({
    error: "The server could not complete this request. Check Worker logs for the request error.",
  });
});

export default app;
