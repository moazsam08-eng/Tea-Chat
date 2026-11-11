import { createClient } from "@supabase/supabase-js";
import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

type StreamBeforeSendPayload = {
  message?: {
    text?: unknown;
    type?: unknown;
    attachments?: unknown;
    silent?: unknown;
  };
  user?: { id?: unknown };
  channel?: { cid?: unknown };
};

function decodeHexSignature(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function verifyStreamSignature(rawBody: Uint8Array, signature: string, secret: string) {
  const signatureBytes = decodeHexSignature(signature);
  if (!signatureBytes) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signatureBytes, rawBody);
}

function rejectMessage(res: Response, text: string) {
  // Stream requires HTTP 200 with a message of type "error" to reject a send.
  res.status(200).json({ message: { type: "error", text } });
}

router.post("/webhooks/stream/before-message-send", async (req: Request, res: Response): Promise<void> => {
  const apiKey = process.env.VITE_STREAM_API_KEY;
  const apiSecret = process.env.STREAM_API_SECRET;
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const rawBody = req.body;

  if (!apiKey || !apiSecret || !supabaseUrl || !serviceRoleKey || !(rawBody instanceof Uint8Array)) {
    console.error("[api] Daily message limit webhook is not configured correctly.");
    rejectMessage(res, "Message limits are temporarily unavailable. Please try again.");
    return;
  }

  if (req.header("x-api-key") !== apiKey) {
    rejectMessage(res, "This message could not be verified. Please try again.");
    return;
  }

  try {
    const validSignature = await verifyStreamSignature(rawBody, req.header("x-signature") ?? "", apiSecret);
    if (!validSignature) {
      console.warn("[api] Rejected a Stream webhook with an invalid signature.");
      rejectMessage(res, "This message could not be verified. Please try again.");
      return;
    }

    const payload = JSON.parse(new TextDecoder().decode(rawBody)) as StreamBeforeSendPayload;
    const message = payload.message;
    const userId = payload.user?.id;
    const channelCid = payload.channel?.cid;
    const text = typeof message?.text === "string" ? message.text.trim() : "";
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];

    // Only ordinary, non-silent text-only messages consume the daily allowance.
    // Attachments, voice notes, call logs, system messages, and empty messages do not.
    const isCountableText = Boolean(
      text &&
      attachments.length === 0 &&
      message?.type === "regular" &&
      message?.silent !== true
    );

    if (!isCountableText) {
      res.status(200).json({});
      return;
    }

    if (typeof userId !== "string" || typeof channelCid !== "string") {
      rejectMessage(res, "This message could not be verified. Please try again.");
      return;
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: count, error } = await supabase.rpc("consume_daily_text_message", {
      p_channel_cid: channelCid,
      p_user_id: userId,
    });

    if (error || typeof count !== "number") {
      console.error("[api] Daily text message counter failed:", error?.message ?? "No count returned");
      rejectMessage(res, "The message limit could not be checked. Please try again.");
      return;
    }

    if (count < 0) {
      rejectMessage(res, "You have used your 10 text messages for this conversation today. Your limit resets at midnight Cairo time.");
      return;
    }

    res.status(200).json({});
  } catch (error) {
    console.error("[api] Before-message-send webhook failed:", error instanceof Error ? error.message : "Unknown error");
    rejectMessage(res, "The message limit could not be checked. Please try again.");
  }
});

export default router;
