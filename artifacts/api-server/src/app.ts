import express, { type Express } from "express";
import cors from "cors";
import router from "./routes";

const app: Express = express();

// Use the Workers runtime logger instead of pino-http, whose Node internals
// are not compatible with the Cloudflare Workers bundle.
app.use((req, _res, next) => {
  console.info(`[api] ${req.method} ${req.path}`);
  next();
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
