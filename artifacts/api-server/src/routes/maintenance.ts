import { createClient } from "@supabase/supabase-js";
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";

const router: IRouter = Router();
const DURATION = 7 * 24 * 60 * 60 * 1000;
const TABLE = "app_maintenance";

function getSupabase() {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Maintenance storage is not configured.");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function isEnabled(): boolean {
  return ["on", "true", "1", "yes"].includes((process.env.MAINTENANCE_MODE ?? "off").trim().toLowerCase());
}

async function syncAndReadState(): Promise<{ active: boolean; startedAt: string | null; endsAt: string | null }> {
  const db = getSupabase();
  if (!isEnabled()) {
    const { error } = await db.from(TABLE).delete().eq("id", "global");
    if (error) throw error;
    return { active: false, startedAt: null, endsAt: null };
  }

  const { data, error } = await db.from(TABLE).select("started_at").eq("id", "global").maybeSingle();
  if (error) throw error;
  if (!data?.started_at) {
    const startedAt = new Date().toISOString();
    const { error: insertError } = await db.from(TABLE).insert({ id: "global", started_at: startedAt });
    if (insertError) throw insertError;
    const endsAt = new Date(Date.parse(startedAt) + DURATION).toISOString();
    return { active: true, startedAt, endsAt };
  }

  const start = new Date(data.started_at).getTime();
  const end = start + DURATION;
  if (!Number.isFinite(start) || Date.now() >= end) {
    return { active: false, startedAt: null, endsAt: null };
  }
  return { active: true, startedAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() };
}

router.get("/maintenance/status", async (_req: Request, res: Response): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  try { res.json(await syncAndReadState()); }
  catch (error) {
    const detail = error && typeof error === "object"
      ? error as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown }
      : null;
    const code = typeof detail?.code === "string" ? detail.code : "UNKNOWN";
    const message = typeof detail?.message === "string" ? detail.message : "Unknown maintenance error";
    console.error("[api] Maintenance status unavailable:", { code, message, details: detail?.details, hint: detail?.hint });
    res.status(503).json({
      error: "Maintenance status is temporarily unavailable.",
      diagnostic: code,
      reason: message,
    });
  }
});

export async function maintenanceGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.path === "/maintenance/status") { next(); return; }
  try {
    const state = await syncAndReadState();
    if (state.active) {
      res.setHeader("Retry-After", "60");
      res.status(503).json({ error: "Tea Chat is temporarily unavailable for scheduled maintenance.", maintenance: true, endsAt: state.endsAt });
      return;
    }
    next();
  } catch (error) {
    // Maintenance is opt-in. A missing setup must never lock users out.
    console.error("[api] Maintenance state could not be checked; allowing normal traffic:", error instanceof Error ? error.message : "Unknown error");
    next();
  }
}

export default router;
