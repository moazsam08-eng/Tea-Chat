import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Temporary diagnostic: expose presence only, never configuration values.
router.get("/config-check", (_req, res) => {
  res.json({
    supabaseUrlConfigured: Boolean(process.env.VITE_SUPABASE_URL?.trim()),
    supabaseAnonKeyConfigured: Boolean(process.env.VITE_SUPABASE_ANON_KEY?.trim()),
    streamApiKeyConfigured: Boolean(process.env.VITE_STREAM_API_KEY?.trim()),
    streamApiSecretConfigured: Boolean(process.env.STREAM_API_SECRET?.trim()),
  });
});

export default router;
