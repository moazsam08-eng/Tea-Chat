import { createClient } from "@supabase/supabase-js";
import { GetStreamTokenResponse } from "@workspace/api-zod";
import { StreamChat } from "stream-chat";
import { Router, type IRouter } from "express";

const router: IRouter = Router();

router.post("/stream/token", async (req, res): Promise<void> => {
  const authorization = req.header("authorization");
  const accessToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!accessToken) {
    res.status(401).json({ error: "Sign in to connect to chat." });
    return;
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  const streamApiKey = process.env.VITE_STREAM_API_KEY;
  const streamApiSecret = process.env.STREAM_API_SECRET;

  if (!supabaseUrl || !supabaseAnonKey || !streamApiKey || !streamApiSecret) {
    res.status(503).json({ error: "Chat sign-in is not configured yet." });
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser(accessToken);

  if (authError || !user) {
    res.status(401).json({ error: "Your session expired. Sign in again." });
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
  } catch {
    req.log.error("Stream token generation failed");
    res.status(502).json({
      error: "Tea Chat could not connect to messaging. Please try again.",
    });
  }
});

export default router;
