import { test } from "node:test";
import assert from "node:assert/strict";
import { askLaya, localAsker, remoteAsker, warmUp } from "../src/router.mjs";

const models = [
  { id: "claude-haiku-4-5-20251001", tier: "haiku", description: "Claude Haiku 4.5" },
  { id: "claude-opus-5", tier: "opus", description: "Claude Opus 5" },
];
const input = { prompt: "fix the typo in README.md", current: "claude-opus-5", contextTokens: 1200, models };

const answers = (extra = {}) => ({
  model: {
    type: "choice",
    choice: "claude-haiku-4-5-20251001",
    probabilities: { "claude-haiku-4-5-20251001": 0.8, "claude-opus-5": 0.2 },
    confidence: 0.28,
    ...extra,
  },
  task_complexity: { type: "score", score: 1.8 },
  reasoning_required: { type: "score", score: 0.9 },
  tool_complexity: { type: "score", score: 2.7 },
});

function recordingFetch(body) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { calls, fetcher };
}

test("remote mode posts to /v1/systemone with the bearer key", async () => {
  const { calls, fetcher } = recordingFetch({ answers: answers({ answer_confidence: 0.8 }) });
  const ask = remoteAsker({ url: "https://laya.example.com/", apiKey: "secret", fetch: fetcher });
  const result = await askLaya(input, ask);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://laya.example.com/v1/systemone");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer secret");
  assert.equal("model" in calls[0].body, false);
  assert.equal(calls[0].body.state.request, input.prompt);
  assert.deepEqual(Object.keys(calls[0].body.questions).sort(), [
    "model",
    "reasoning_required",
    "task_complexity",
    "tool_complexity",
  ]);
  assert.equal(result.choice, "claude-haiku-4-5-20251001");
  assert.equal(result.confidence, 0.8);
  assert.equal(result.metrics.taskComplexity, 0.2);
});

test("remote mode sends no authorization header without a key, and the checkpoint when set", async () => {
  const { calls, fetcher } = recordingFetch({ answers: answers() });
  await askLaya(input, remoteAsker({ url: "http://127.0.0.1:8000", model: "multilingual", fetch: fetcher }));

  assert.equal(calls[0].url, "http://127.0.0.1:8000/v1/systemone");
  assert.equal("authorization" in calls[0].init.headers, false);
  assert.equal(calls[0].body.model, "multilingual");
});

test("remote mode retries once, then gives up and keeps the current model", async () => {
  let attempts = 0;
  const fetcher = async () => {
    attempts++;
    return new Response("overloaded", { status: 503 });
  };
  assert.equal(await askLaya(input, remoteAsker({ url: "http://127.0.0.1:8000", fetch: fetcher })), null);
  assert.equal(attempts, 2);
});

test("local mode asks the shared server for the multilingual checkpoint", async () => {
  const { calls, fetcher } = recordingFetch({ answers: answers() });
  const ensured = [];
  const ask = localAsker({
    env: { LAYA_LOCAL_PORT: "8799", LAYA_API_KEY: "remote-only" },
    fetch: fetcher,
    ensure: async (options) => {
      ensured.push(options.env.LAYA_LOCAL_PORT);
      return true;
    },
  });

  const first = await askLaya(input, ask);
  await askLaya(input, ask);

  assert.deepEqual(ensured, ["8799"], "a healthy server is checked once, not before every prompt");
  assert.equal(calls[0].url, "http://127.0.0.1:8799/v1/systemone");
  assert.equal(calls[0].body.model, "multilingual");
  assert.equal("authorization" in calls[0].init.headers, false);
  assert.equal(first.confidence, 0.8, "confidence falls back to the top probability");
});

test("local mode keeps the current model while the server is starting", async () => {
  const { calls, fetcher } = recordingFetch({ answers: answers() });
  let starting = true;
  const ask = localAsker({ env: {}, fetch: fetcher, ensure: async () => !starting });

  assert.equal(await askLaya(input, ask), null);
  assert.equal(calls.length, 0);
  starting = false;
  assert.equal((await askLaya(input, ask)).choice, "claude-haiku-4-5-20251001");
  assert.equal(calls[0].url, "http://127.0.0.1:8765/v1/systemone");
});

test("local mode re-checks the server after a failed request", async () => {
  let ensures = 0;
  let down = true;
  const fetcher = async () => {
    if (down) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ answers: answers() }), { status: 200 });
  };
  const ask = localAsker({ env: {}, fetch: fetcher, ensure: async () => ++ensures > 0 });

  assert.equal(await askLaya(input, ask), null);
  down = false;
  assert.notEqual(await askLaya(input, ask), null);
  assert.equal(ensures, 2);
});

test("warm-up starts the local server only in local mode and reports a missing uv", async () => {
  const started = [];
  const ensure = async ({ env }) => started.push(env);
  assert.equal(await warmUp({ LAYA_URL: "https://laya.example.com" }, ensure), null);
  assert.equal(started.length, 0);
  assert.equal(await warmUp({}, ensure), null);
  assert.equal(started.length, 1);
  const missing = await warmUp({}, async () => {
    throw new Error("uv is required to run Laya locally");
  });
  assert.match(missing, /uv is required/);
});

test("an answer without a model choice keeps the current model", async () => {
  const ask = async () => ({ answers: { ...answers(), model: { type: "choice" } } });
  assert.equal(await askLaya(input, ask), null);
});

test("choice options are plain strings that fit Laya's option schema", async () => {
  let questions;
  await askLaya(input, async (request) => {
    questions = request.questions;
    return { answers: answers() };
  });
  assert.equal(typeof questions.model.instructions, "string");
  for (const description of Object.values(questions.model.criteria)) assert.equal(typeof description, "string");
  assert.match(questions.model.criteria["claude-opus-5"], /^Claude Opus 5\. Hard reasoning/);
});
