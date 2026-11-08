import { createClient } from "@supabase/supabase-js";
import { GetStreamTokenResponse } from "@workspace/api-zod";
import { StreamChat } from "stream-chat";
import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

async function authenticateSupabaseUser(req: Request, res: Response) {
  const authorization = req.header("authorization");
  const accessToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!accessToken) {
    res.status(401).json({ error: "Sign in to connect to chat." });
    return null;
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    res.status(503).json({ error: "Sign-in is not configured yet." });
    return null;
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  try {
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(accessToken);

    if (authError || !user) {
      console.error("[api] Supabase session validation failed:", authError?.message ?? "No user returned");
      res.status(401).json({ error: "Your session expired. Sign in again." });
      return null;
    }

    return user;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Supabase authentication error";
    console.error("[api] Supabase session validation threw:", message);
    res.status(502).json({ error: "Could not verify your sign-in session. Please try again." });
    return null;
  }
}

function getStreamServerClient(res: Response) {
  const streamApiKey = process.env.VITE_STREAM_API_KEY;
  const streamApiSecret = process.env.STREAM_API_SECRET;
  if (!streamApiKey || !streamApiSecret) {
    res.status(503).json({ error: "Chat is not configured yet." });
    return null;
  }
  return StreamChat.getInstance(streamApiKey, streamApiSecret);
}

router.post("/stream/token", async (req, res): Promise<void> => {
  const user = await authenticateSupabaseUser(req, res);
  if (!user) return;

  const streamApiKey = process.env.VITE_STREAM_API_KEY;
  const streamApiSecret = process.env.STREAM_API_SECRET;
  if (!streamApiKey || !streamApiSecret) {
    res.status(503).json({ error: "Chat sign-in is not configured yet." });
    return;
  }

  const candidateName =
    user.user_metadata?.full_name ??
    user.user_metadata?.name ??
    user.email?.split("@")[0] ??
    "Tea Chat member";
  const name =
    typeof candidateName === "string" && candidateName.trim()
      ? candidateName.trim()
      : "Tea Chat member";
  const candidateImage =
    user.user_metadata?.avatar_url ?? user.user_metadata?.picture ?? null;
  const image =
    typeof candidateImage === "string" && candidateImage.trim()
      ? candidateImage.trim()
      : null;

  try {
    const stream = StreamChat.getInstance(streamApiKey, streamApiSecret);
    await stream.upsertUser({
      id: user.id,
      name,
      ...(image ? { image } : {}),
    });

    const response = GetStreamTokenResponse.parse({
      userId: user.id,
      name,
      image,
      token: stream.createToken(user.id),
    });

    res.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Stream error";
    console.error("[api] Stream token generation failed:", message);
    res.status(502).json({
      error: "Tea Chat could not connect to messaging. Please try again.",
    });
  }
});

router.get("/people", async (req, res): Promise<void> => {
  const user = await authenticateSupabaseUser(req, res);
  if (!user) return;
  const stream = getStreamServerClient(res);
  if (!stream) return;

  const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 80) : "";
  const idsValue = typeof req.query.ids === "string" ? req.query.ids : "";
  const ids = idsValue
    ? [...new Set(idsValue.split(",").map((id) => id.trim()).filter(Boolean))]
    : [];

  if (ids.length > 100 || ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) {
    res.status(400).json({ error: "The requested profile list is invalid." });
    return;
  }

  const filters: Record<string, unknown> = ids.length
    ? { id: { $in: ids } }
    : { id: { $ne: user.id } };
  if (search && !ids.length) filters.name = { $autocomplete: search };

  const offsetValue = Number(req.query.offset ?? 0);
  const offset = Number.isInteger(offsetValue) ? Math.min(Math.max(offsetValue, 0), 1000) : 0;

  try {
    const response = await stream.queryUsers(
      filters as never,
      { name: 1 },
      { limit: ids.length ? Math.max(ids.length, 1) : 25, offset, presence: false },
    );
    res.json({
      users: response.users.map((person) => ({
        id: person.id,
        name: typeof person.name === "string" && person.name.trim() ? person.name.trim() : "Tea Chat member",
        image: typeof person.image === "string" ? person.image : null,
      })),
      nextOffset: response.users.length === 25 && !ids.length ? offset + 25 : null,
    });
  } catch {
    console.error("Tea Chat people directory query failed");
    res.status(502).json({ error: "The people directory is unavailable. Please try again." });
  }
});

router.put("/stream/profile", async (req, res): Promise<void> => {
  const user = await authenticateSupabaseUser(req, res);
  if (!user) return;
  const stream = getStreamServerClient(res);
  if (!stream) return;

  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const image = req.body?.image;
  if (name.length < 2 || name.length > 60) {
    res.status(400).json({ error: "Your name must be between 2 and 60 characters." });
    return;
  }
  if (
    image !== null &&
    (typeof image !== "string" ||
      image.length > 2048 ||
      !/^https:\/\//i.test(image))
  ) {
    res.status(400).json({ error: "Profile photos must use a secure HTTPS URL." });
    return;
  }

  try {
    await stream.partialUpdateUser({
      id: user.id,
      set: image ? { name, image } : { name },
      ...(image === null ? { unset: ["image"] } : {}),
    });
    res.json({ name, image });
  } catch {
    console.error("Tea Chat profile update failed");
    res.status(502).json({ error: "Your chat profile could not be updated. Please try again." });
  }
});

export default router;
