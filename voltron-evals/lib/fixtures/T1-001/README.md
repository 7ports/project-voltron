# voltron-evals-fixture-t1-001

Express-based fixture used by the Project Voltron benchmark harness.

## Endpoints

| Method | Path               | Description                                                                                                                  |
| ------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/`                | Returns the fixture metadata (`name`, `version`).                                                                            |
| GET    | `/health`          | Liveness probe. Returns `{ "status": "ok" }`.                                                                                |
| POST   | `/stripe/webhook`  | Stripe webhook receiver. Verifies the `Stripe-Signature` header against `STRIPE_WEBHOOK_SECRET` (HMAC-SHA256 over `t.rawBody`). Invalid or missing signatures are rejected with HTTP 400. Verified payloads are dispatched through the `withRetry` helper (exponential backoff, capped attempts). |

## Configuration

| Variable                 | Required | Description                                                                                  |
| ------------------------ | -------- | -------------------------------------------------------------------------------------------- |
| `PORT`                   | no       | Listening port. Defaults to `3000`.                                                          |
| `STRIPE_WEBHOOK_SECRET`  | yes      | Shared secret used to verify the `Stripe-Signature` header on `POST /stripe/webhook`.        |

## Project layout

```
server/
  src/
    index.ts            # Express bootstrap; mounts routes
    routes/
      webhooks.ts       # POST /stripe/webhook — signature verification + retry dispatch
    lib/
      retry.ts          # Generic withRetry(fn, opts) helper (exponential backoff)
      retry.test.ts     # node:test integration tests for withRetry
```

## Tests

Retry helper tests run via Node's built-in test runner:

```bash
node --test --import tsx server/src/lib/retry.test.ts
```
