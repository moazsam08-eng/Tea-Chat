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

function isAdmin(req: Request): boolean {
  const key = process.env.MAINTENANCE_ADMIN_KEY ?? "";
  return Boolean(key && req.header("x-maintenance-key") === key);
}

export async function readMaintenanceState(): Promise<{ active: boolean; startedAt: string | null; endsAt: string | null }> {
  const { data, error } = await getSupabase().from(TABLE).select("started_at").eq("id", "global").maybeSingle();
  if (error) throw error;
  if (!data?.started_at) return { active: false, startedAt: null, endsAt: null };
  const start = new Date(data.started_at).getTime();
  const end = start + DURATION;
  const active = Number.isFinite(start) && Date.now() < end;
  return { active, startedAt: active ? new Date(start).toISOString() : null, endsAt: active ? new Date(end).toISOString() : null };
}

router.get("/maintenance/status", async (_req: Request, res: Response): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  try { res.json(await readMaintenanceState()); }
  catch (error) {
    console.error("[api] Maintenance status unavailable:", error instanceof Error ? error.message : "Unknown error");
    res.status(503).json({ error: "Maintenance status is temporarily unavailable." });
  }
});

router.post("/maintenance/activate", async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) { res.status(401).json({ error: "Unauthorized." }); return; }
  try {
    const startedAt = new Date().toISOString();
    const { error } = await getSupabase().from(TABLE).upsert({ id: "global", started_at: startedAt }, { onConflict: "id" });
    if (error) throw error;
    res.setHeader("Cache-Control", "no-store");
    res.json({ active: true, startedAt, endsAt: new Date(Date.now() + DURATION).toISOString() });
  } catch (error) {
    console.error("[api] Could not activate maintenance:", error instanceof Error ? error.message : "Unknown error");
    res.status(503).json({ error: "Could not activate maintenance mode." });
  }
});

router.post("/maintenance/deactivate", async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) { res.status(401).json({ error: "Unauthorized." }); return; }
  try {
    const { error } = await getSupabase().from(TABLE).delete().eq("id", "global");
    if (error) throw error;
    res.json({ active: false, startedAt: null, endsAt: null });
  } catch (error) {
    console.error("[api] Could not deactivate maintenance:", error instanceof Error ? error.message : "Unknown error");
    res.status(503).json({ error: "Could not deactivate maintenance mode." });
  }
});

export async function maintenanceGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (["/maintenance/status", "/maintenance/activate", "/maintenance/deactivate"].includes(req.path)) { next(); return; }
  try {
    const state = await readMaintenanceState();
    if (state.active) {
      res.setHeader("Retry-After", "60");
      res.status(503).json({ error: "Tea Chat is temporarily unavailable for scheduled maintenance.", maintenance: true, endsAt: state.endsAt });
      return;
    }
    next();
  } catch (error) {
    // Maintenance is opt-in. If its table or credentials are not ready, keep the
    // existing chat service available rather than accidentally locking everyone out.
    console.error("[api] Maintenance state could not be checked; allowing normal traffic:", error instanceof Error ? error.message : "Unknown error");
    next();
  }
}}

export default router;
