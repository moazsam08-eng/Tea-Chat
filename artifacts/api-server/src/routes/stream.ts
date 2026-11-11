import { createClient } from "@supabase/supabase-js";
import { GetStreamTokenResponse } from "@workspace/api-zod";
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


function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

async function createStreamUserToken(userId: string, apiSecret: string): Promise<string> {
  const encoder = new TextEncoder();
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64UrlEncode(encoder.encode(JSON.stringify({
    user_id: userId,
    iat: now,
    exp: now + 60 * 60,
  })));
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function createStreamServerToken(apiSecret: string): Promise<string> {
  const encoder = new TextEncoder();
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64UrlEncode(encoder.encode(JSON.stringify({ server: true, iat: now })));
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function streamApiRequest(
  apiKey: string,
  apiSecret: string,
  path: string,
  init: RequestInit = {},
): Promise<globalThis.Response> {
  const token = await createStreamServerToken(apiSecret);
  const url = new URL(`https://chat.stream-io-api.com/api/v2/${path}`);
  url.searchParams.set("api_key", apiKey);
  return fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: token,
      "Stream-Auth-Type": "jwt",
      ...init.headers,
    },
  });
}

function getStreamCredentials(res: Response) {
  const apiKey = process.env.VITE_STREAM_API_KEY;
  const apiSecret = process.env.STREAM_API_SECRET;
  if (!apiKey || !apiSecret) {
    res.status(503).json({ error: "Chat is not configured yet." });
    return null;
  }
  return { apiKey, apiSecret };
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
    // Cloudflare Workers do not provide Node's https.Agent. Sign the
    // Stream user JWT with Web Crypto; connectUser() on the client syncs the user.
    const response = GetStreamTokenResponse.parse({
      userId: user.id,
      name,
      image,
      token: await createStreamUserToken(user.id, streamApiSecret),
    });

    res.json(response);
  } catch (error) {
    const details = error && typeof error === "object"
      ? error as { name?: unknown; message?: unknown; code?: unknown; status?: unknown; response?: { status?: unknown } }
      : null;
    console.error("[api] Stream token generation failed", {
      name: typeof details?.name === "string" ? details.name : "UnknownError",
      message: typeof details?.message === "string" ? details.message : "Unknown Stream error",
      code: details?.code ?? null,
      status: details?.status ?? details?.response?.status ?? null,
    });
    res.status(502).json({
      error: "Tea Chat could not connect to messaging. Please try again.",
    });
  }
});

router.get("/people", async (req, res): Promise<void> => {
  const user = await authenticateSupabaseUser(req, res);
  if (!user) return;
  const credentials = getStreamCredentials(res);
  if (!credentials) return;

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
    const payload = {
      filter_conditions: filters,
      sort: [{ field: "name", direction: 1 }],
      limit: ids.length ? Math.max(ids.length, 1) : 25,
      offset,
    };
    const url = new URL("https://chat.stream-io-api.com/api/v2/users");
    url.searchParams.set("api_key", credentials.apiKey);
    url.searchParams.set("payload", JSON.stringify(payload));
    const response = await streamApiRequest(
      credentials.apiKey,
      credentials.apiSecret,
      `users?${url.searchParams.toString().replace(/^api_key=[^&]*&?/, "")}`,
    );
    if (!response.ok) {
      const detail = await response.text();
      console.error("[api] Stream user directory request failed", { status: response.status, detail });
      res.status(502).json({ error: "The people directory is unavailable. Please try again." });
      return;
    }
    const data = await response.json() as { users?: Array<{ id: string; name?: unknown; image?: unknown }> };
    const users = Array.isArray(data.users) ? data.users : [];
    res.json({
      users: users.map((person) => ({
        id: person.id,
        name: typeof person.name === "string" && person.name.trim() ? person.name.trim() : "Tea Chat member",
        image: typeof person.image === "string" ? person.image : null,
      })),
      nextOffset: users.length === 25 && !ids.length ? offset + 25 : null,
    });
  } catch {
    console.error("Tea Chat people directory query failed");
    res.status(502).json({ error: "The people directory is unavailable. Please try again." });
  }
});

router.put("/stream/profile", async (req, res): Promise<void> => {
  const user = await authenticateSupabaseUser(req, res);
  if (!user) return;
  const credentials = getStreamCredentials(res);
  if (!credentials) return;

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
    const userUpdate: Record<string, unknown> = { id: user.id, name };
    if (image) userUpdate.image = image;
    const response = await streamApiRequest(
      credentials.apiKey,
      credentials.apiSecret,
      "users",
      {
        method: "POST",
        body: JSON.stringify({ users: { [user.id]: userUpdate } }),
      },
    );
    if (!response.ok) {
      const detail = await response.text();
      console.error("[api] Stream profile update failed", { status: response.status, detail });
      res.status(502).json({ error: "Your chat profile could not be updated. Please try again." });
      return;
    }
    res.json({ name, image });
  } catch {
    console.error("Tea Chat profile update failed");
    res.status(502).json({ error: "Your chat profile could not be updated. Please try again." });
  }
});

export default router;
