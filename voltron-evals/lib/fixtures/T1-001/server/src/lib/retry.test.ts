import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetry } from "./retry";

const noSleep = (_ms: number): Promise<void> => Promise.resolve();

test("withRetry — flaky fake succeeds on the third attempt", async () => {
  let attempts = 0;
  const flaky = async (attempt: number): Promise<string> => {
    attempts = attempt;
    if (attempt < 3) {
      throw new Error(`transient failure on attempt ${attempt}`);
    }
    return "ok";
  };

  const result = await withRetry(flaky, {
    maxAttempts: 5,
    baseDelayMs: 1,
    sleep: noSleep,
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 3, "should succeed on the third attempt");
});

test("withRetry — permanently-failing fake exhausts attempts and surfaces the last error", async () => {
  let attempts = 0;
  const permanentlyFailing = async (attempt: number): Promise<never> => {
    attempts = attempt;
    throw new Error(`permanent failure on attempt ${attempt}`);
  };

  await assert.rejects(
    () =>
      withRetry(permanentlyFailing, {
        maxAttempts: 4,
        baseDelayMs: 1,
        sleep: noSleep,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "permanent failure on attempt 4");
      return true;
    },
  );

  assert.equal(attempts, 4, "should exhaust exactly maxAttempts attempts");
});

test("withRetry — invokes onRetry between attempts with monotonic delays", async () => {
  const delays: number[] = [];
  let calls = 0;

  await assert.rejects(() =>
    withRetry(
      async () => {
        calls++;
        throw new Error("boom");
      },
      {
        maxAttempts: 4,
        baseDelayMs: 10,
        factor: 2,
        sleep: noSleep,
        onRetry: (_err, _attempt, delayMs) => {
          delays.push(delayMs);
        },
      },
    ),
  );

  assert.equal(calls, 4);
  assert.deepEqual(delays, [10, 20, 40]);
});
