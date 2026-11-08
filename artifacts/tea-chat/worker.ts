import { createServer } from "node:http";
import { httpServerHandler } from "cloudflare:node";
import app from "../api-server/src/app";

// Keep the existing Express API and expose it through the Workers Node.js
// HTTP server adapter. Wrangler's assets router sends /api/* requests here.
const server = createServer(app);

export default httpServerHandler(server);
