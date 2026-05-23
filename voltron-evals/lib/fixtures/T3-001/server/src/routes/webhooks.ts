import { Router, Request, Response } from "express";

const router = Router();

// STUB: signature verification + retryable dispatcher are NOT yet implemented.
// T3-001's deliverable is to:
//   1. add HMAC signature verification keyed on STRIPE_WEBHOOK_SECRET
//   2. reject missing / invalid signatures with HTTP 400
//   3. hand the verified payload to the retry helper from server/src/lib/retry.ts
router.post("/stripe/webhook", (req: Request, res: Response) => {
  res.status(200).json({ received: true, verified: false });
});

export default router;
