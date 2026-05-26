import crypto from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import { withRetry } from "../lib/retry";

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export interface StripeWebhookEvent {
  id?: string;
  type?: string;
  data?: unknown;
  [key: string]: unknown;
}

export type WebhookHandler = (event: StripeWebhookEvent) => Promise<void>;

function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } | null {
  const parts = header.split(",");
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of parts) {
    const [key, value] = part.split("=");
    if (!key || !value) continue;
    if (key === "t") {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed)) return null;
      timestamp = parsed;
    } else if (key === "v1") {
      signatures.push(value);
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export function verifyStripeSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!signatureHeader || !secret) return false;
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return false;
  if (Math.abs(nowSeconds - parsed.timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const payload = `${parsed.timestamp}.${typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return parsed.signatures.some((sig) => timingSafeEqualHex(sig, expected));
}

export interface CreateWebhookRouterOptions {
  secret?: string;
  handler?: WebhookHandler;
  maxAttempts?: number;
}

const defaultHandler: WebhookHandler = async () => {};

export function createWebhookRouter(opts: CreateWebhookRouterOptions = {}): Router {
  const router = express.Router();
  const handler = opts.handler ?? defaultHandler;

  router.post(
    "/stripe/webhook",
    express.raw({ type: "application/json" }),
    async (req: Request, res: Response) => {
      const secret = opts.secret ?? process.env.STRIPE_WEBHOOK_SECRET;
      if (!secret) {
        res.status(500).json({ error: "STRIPE_WEBHOOK_SECRET is not configured" });
        return;
      }
      const sigHeader = req.header("stripe-signature");
      const rawBody = req.body as Buffer;
      if (!verifyStripeSignature(rawBody, sigHeader, secret)) {
        res.status(400).json({ error: "invalid signature" });
        return;
      }
      let event: StripeWebhookEvent;
      try {
        event = JSON.parse(rawBody.toString("utf8")) as StripeWebhookEvent;
      } catch {
        res.status(400).json({ error: "invalid JSON payload" });
        return;
      }
      try {
        await withRetry(() => handler(event), { maxAttempts: opts.maxAttempts ?? 3 });
        res.status(200).json({ received: true });
      } catch (err) {
        res.status(500).json({ error: "handler failed after retries", message: (err as Error).message });
      }
    },
  );

  return router;
}

export default createWebhookRouter;
