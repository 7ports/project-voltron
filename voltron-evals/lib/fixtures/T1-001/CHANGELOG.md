# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Stripe webhook signature verification** — new `POST /stripe/webhook` endpoint in `server/src/routes/webhooks.ts` that validates the `Stripe-Signature` header against `STRIPE_WEBHOOK_SECRET` using HMAC-SHA256 over `timestamp.rawBody`. Requests with missing or invalid signatures are rejected with HTTP 400 before any handler runs.
- **Retryable dispatcher** — new generic `withRetry(fn, opts)` helper in `server/src/lib/retry.ts` providing exponential backoff with a configurable max-attempts cap, base/max delay, multiplier, and optional `shouldRetry` predicate / `onRetry` callback. The webhook route uses this helper to dispatch verified payloads with bounded retries.
- **Integration tests for the retry helper** — `server/src/lib/retry.test.ts` exercises both a flaky fake that succeeds on the third attempt and a permanently-failing fake that exhausts the attempt cap and surfaces the last error.
