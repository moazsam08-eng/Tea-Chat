import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Router, type IRouter, type Request, type Response } from "express";
import { StreamChat } from "stream-chat";

const router: IRouter = Router();
const AI_USER_ID = "tea-chat-assistant";
const MAX_MESSAGE_LENGTH = 5000;
const MAX_IMAGE_DATA_URL_LENGTH = 7_100_000;
const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 12;
const requestTimes = new Map<string, number[]>();

type GroqChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  >;
};

type GroqStreamChunk = {
  choices?: Array<{ delta?: { content?: unknown } }>;
};

async function authenticateSupabaseUser(req: Request, res: Response) {
  const accessToken = req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!accessToken) {
    res.status(401).json({ error: "Sign in to use Tea AI." });
    return null;
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    res.status(503).json({ error: "Sign-in is not configured yet." });
    return null;
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: { user }, error } = await supabase.auth.getUser(accessToken);
  if (error || !user) {
    res.status(401).json({ error: "Your session expired. Sign in again." });
    return null;
  }
  return user;
}

function getStreamServerClient(res: Response) {
  const apiKey = process.env.VITE_STREAM_API_KEY;
  const apiSecret = process.env.STREAM_API_SECRET;
  if (!apiKey || !apiSecret) {
    res.status(503).json({ error: "Tea Chat messaging is not configured yet." });
    return null;
  }
  return StreamChat.getInstance(apiKey, apiSecret);
}

function checkRateLimit(userId: string, res: Response): boolean {
  const now = Date.now();
  const recent = (requestTimes.get(userId) ?? []).filter((time) => now - time < RATE_WINDOW_MS);
  if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
    res.status(429).json({ error: "You’re sending messages quickly. Wait a moment and try again." });
    return false;
  }
  requestTimes.set(userId, [...recent, now]);
  return true;
}

router.post("/assistant/conversations", async (req, res): Promise<void> => {
  const user = await authenticateSupabaseUser(req, res);
  if (!user) return;
  if (!checkRateLimit(user.id, res)) return;
  const stream = getStreamServerClient(res);
  if (!stream) return;

  const channelId = "tea-ai-" + randomUUID().replace(/-/g, "");
  try {
    await stream.upsertUser({ id: AI_USER_ID, name: "Tea AI" });
    const channel = stream.channel("messaging", channelId, {
      name: "Tea AI chat",
      ai_assistant: true,
      created_by_id: user.id,
      members: [user.id, AI_USER_ID],
    } as never);
    await channel.create();
    res.status(201).json({ id: channelId, title: "Tea AI chat" });
  } catch {
    req.log.error("Tea AI conversation creation failed");
    res.status(502).json({ error: "A new AI chat could not be created. Please try again." });
  }
});

router.post("/assistant/conversations/:channelId/respond", async (req, res): Promise<void> => {
  const user = await authenticateSupabaseUser(req, res);
  if (!user) return;
  if (!checkRateLimit(user.id, res)) return;

  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    res.status(503).json({ error: "Add GROQ_API_KEY to server Secrets to enable Tea AI." });
    return;
  }
  const stream = getStreamServerClient(res);
  if (!stream) return;

  const channelId = req.params.channelId;
  const messageId = req.body?.messageId;
  if (typeof channelId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(channelId)) {
    res.status(400).json({ error: "This AI chat is invalid." });
    return;
  }
  if (typeof messageId !== "string" || messageId.length < 1 || messageId.length > 64) {
    res.status(400).json({ error: "The message could not be identified." });
    return;
  }

  let imageDataUrl: string | undefined;
  if (req.body?.imageDataUrl !== undefined) {
    if (typeof req.body.imageDataUrl !== "string" || req.body.imageDataUrl.length > MAX_IMAGE_DATA_URL_LENGTH ||
      !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(req.body.imageDataUrl)) {
      res.status(400).json({ error: "Choose a JPEG, PNG, or WebP photo up to 5 MB." });
      return;
    }
    imageDataUrl = req.body.imageDataUrl;
  }

  try {
    const channels = await stream.queryChannels(
      { type: "messaging", cid: "messaging:" + channelId, members: { $in: [user.id] }, ai_assistant: true } as never,
      { last_message_at: -1 },
      { state: true, watch: false, limit: 1, message_limit: 30 },
    );
    const channel = channels[0];
    const channelData = channel?.data as unknown as Record<string, unknown> | undefined;
    if (!channel || channelData?.ai_assistant !== true || !channel.state.members[user.id]) {
      res.status(404).json({ error: "This AI chat could not be found." });
      return;
    }

    const messages = channel.state.messages;
    const targetIndex = messages.findIndex((message) => message.id === messageId);
    const target = messages[targetIndex];
    if (!target || target.type !== "regular" || target.user?.id !== user.id) {
      res.status(400).json({ error: "Only your own messages can be sent to Tea AI." });
      return;
    }
    const priorReply = messages.some((message) => {
      const custom = message as unknown as { ai_reply_to_id?: string };
      return message.user?.id === AI_USER_ID && custom.ai_reply_to_id === messageId;
    });
    if (priorReply) {
      res.status(409).json({ error: "Tea AI has already answered that message." });
      return;
    }
    const latestMessage = [...messages].reverse().find((message) => message.type === "regular");
    if (latestMessage?.id !== messageId) {
      res.status(409).json({ error: "Send a new message before asking Tea AI to reply." });
      return;
    }
    const userText = typeof target.text === "string" ? target.text.trim().slice(0, MAX_MESSAGE_LENGTH) : "";
    if (!userText && !imageDataUrl) {
      res.status(400).json({ error: "Write a message or attach a photo first." });
      return;
    }

    const history: GroqChatMessage[] = [
      {
        role: "system",
        content: "You are Tea AI, the friendly assistant inside Tea Chat. Understand and respond to the user in the language they use unless they request another language. Be clear, useful, and conversational. When a user shares a photo, describe and reason about what is visible without claiming certainty beyond the image.",
      },
    ];
    const contextMessages = messages.slice(Math.max(0, targetIndex - 19), targetIndex + 1);
    for (const message of contextMessages) {
      const senderId = message.user?.id;
      const role = senderId === AI_USER_ID ? "assistant" : senderId === user.id ? "user" : null;
      if (!role || message.type !== "regular") continue;
      const text = typeof message.text === "string" ? message.text.trim().slice(0, MAX_MESSAGE_LENGTH) : "";
      if (message.id === messageId && imageDataUrl) {
        history.push({
          role: "user",
          content: [
            { type: "text", text: text || "Please describe this image." },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        });
      } else {
        history.push({
          role,
          content: text || (role === "user" ? "[The user attached a photo in an earlier message.]" : "[No text response.]"),
        });
      }
    }

    const controller = new AbortController();
    const abortIfDisconnected = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", abortIfDisconnected);
    const timeout = setTimeout(() => controller.abort(), 60_000);
    let upstream: globalThis.Response;
    try {
      upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + groqApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.GROQ_MODEL || "qwen/qwen3.8-27b",
          messages: history,
          stream: true,
          temperature: 0.6,
          max_completion_tokens: 1200,
        }),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      res.off("close", abortIfDisconnected);
      if (controller.signal.aborted) {
        if (!res.destroyed) res.status(504).json({ error: "Tea AI took too long to respond. Please try again." });
        return;
      }
      res.status(502).json({ error: "Tea AI could not connect to the AI service. Please try again." });
      return;
    }

    if (!upstream.ok || !upstream.body) {
      clearTimeout(timeout);
      res.off("close", abortIfDisconnected);
      req.log.warn({ status: upstream.status }, "Groq assistant request was rejected");
      res.status(upstream.status === 429 ? 429 : 502).json({
        error: upstream.status === 429 ? "Tea AI is busy right now. Try again in a moment." : "Tea AI could not answer. Check the Groq model setting and try again.",
      });
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    let reply = "";
    let buffer = "";
    let providerDone = false;
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    const consumeLine = (line: string) => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (!data) return;
      if (data === "[DONE]") {
        providerDone = true;
        return;
      }
      const chunk = JSON.parse(data) as GroqStreamChunk;
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        reply += delta;
        if (!res.writableEnded) res.write("data: " + JSON.stringify({ delta }) + "\n\n");
      }
    };

    try {
      while (!providerDone) {
        const next = await reader.read();
        buffer += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) consumeLine(line);
        if (next.done) break;
        if (res.destroyed) {
          await reader.cancel();
          return;
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) consumeLine(buffer.trim());
      if (!reply.trim()) throw new Error("The model returned an empty response.");
      await channel.sendMessage({
        text: reply.trim(),
        user_id: AI_USER_ID,
        ai_reply_to_id: messageId,
      });
      if (!res.writableEnded) {
        res.write("data: " + JSON.stringify({ done: true }) + "\n\n");
        res.end();
      }
    } catch {
      req.log.error("Tea AI response generation or message persistence failed");
      if (!res.destroyed && !res.writableEnded) {
        res.write("data: " + JSON.stringify({ error: "Tea AI could not finish or save its reply. Please retry." }) + "\n\n");
        res.end();
      }
    } finally {
      clearTimeout(timeout);
      res.off("close", abortIfDisconnected);
      reader.releaseLock();
    }
  } catch {
    req.log.error("Tea AI conversation lookup failed");
    if (!res.headersSent) res.status(502).json({ error: "Tea AI could not read this conversation. Please try again." });
  }
});

export default router;
