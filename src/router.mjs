import {
  COMPLEXITY_MAX_SCORE,
  CONTEXT_WINDOW_TOKENS,
  QUESTIONS,
  questionForModels,
  THRESHOLDS,
} from "./config.mjs";
import { log } from "./log.mjs";
import { ensureLocalServer, LOCAL_MODEL, localBaseUrl } from "./local-server.mjs";

/**
 * Remote mode: a Jev-compatible `laya-serve` (`POST /v1/systemone`), on this machine or on a
 * server; local mode reuses it against the shared local server. The bearer header is sent
 * only when a key is configured, and `model` (a laya-serve checkpoint name) only when set, so
 * the server's own routing stays in charge otherwise.
 */
export function remoteAsker({ url, apiKey, model, fetch: fetcher = fetch }) {
  const endpoint = `${url.replace(/\/+$/, "")}/v1/systemone`;
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return async (request, signal) => {
    let lastError;
    for (let attempt = 0; attempt <= THRESHOLDS.layaMaxRetries; attempt++) {
      if (signal.aborted) break;
      try {
        const response = await fetcher(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(model ? { model, ...request } : request),
          signal: AbortSignal.any([signal, AbortSignal.timeout(THRESHOLDS.layaTimeoutMs)]),
        });
        if (!response.ok) throw new Error(`Laya request failed (${response.status})`);
        return await response.json();
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error("Laya deadline exceeded");
  };
}

/**
 * Local mode: the shared laya-serve on 127.0.0.1 (see local-server.mjs), always asked for the
 * multilingual checkpoint. While the server is starting, calls fail fast so the policy keeps
 * the current model; nothing waits for the boot. A failed request re-checks the server on the
 * next call, which restarts it if it died.
 */
export function localAsker({ env = process.env, fetch: fetcher = fetch, ensure = ensureLocalServer } = {}) {
  const remote = remoteAsker({ url: localBaseUrl(env), model: LOCAL_MODEL, fetch: fetcher });
  let ready = false;
  return async (request, signal) => {
    if (!ready) ready = await ensure({ env, fetch: fetcher });
    if (!ready) throw new Error("the local Laya server is starting");
    try {
      return await remote(request, signal);
    } catch (err) {
      ready = false;
      throw err;
    }
  };
}

/** Remote when `LAYA_URL` is set, the shared local server otherwise. */
export const askerFromEnv = (env = process.env) =>
  env.LAYA_URL
    ? remoteAsker({ url: env.LAYA_URL, apiKey: env.LAYA_API_KEY, model: env.LAYA_MODEL })
    : localAsker({ env });

/**
 * Starts the local server early, at proxy launch, so it is warm by the first prompt. Returns
 * an error message for the user (uv missing), or null. Never waits for the server to boot.
 */
export async function warmUp(env = process.env, ensure = ensureLocalServer) {
  if (env.LAYA_URL) return null;
  try {
    await ensure({ env });
    return null;
  } catch (err) {
    return err.message;
  }
}

/**
 * Probability of the chosen option, which laya-serve reports as `answer_confidence` (read from
 * the distribution when a server omits it). Laya's own `confidence` field is 1 - normalized
 * entropy, a different scale from the one the policy thresholds expect.
 */
const choiceConfidence = (answer) =>
  answer.answer_confidence ?? Math.max(...Object.values(answer.probabilities ?? {}));

let defaultAsker;

/**
 * Asks Laya which tier fits this prompt. Returns null on any failure, which the policy
 * layer reads as "keep the current model" — routing must never block a prompt.
 *
 * @returns {Promise<?{choice: string, confidence: number, probabilities: object, metrics: object, ms: number}>}
 */
export async function askLaya({ prompt, current, contextTokens, models }, ask = (defaultAsker ??= askerFromEnv())) {
  if (!models?.length) return null;
  const started = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), THRESHOLDS.layaDeadlineMs);
  const request = {
    state: {
      request: prompt,
      session: { current_model: current, context_tokens: contextTokens },
      environment: { available_models: models.map((model) => model.id) },
    },
    questions: { ...QUESTIONS, model: questionForModels(models) },
  };
  try {
    const result = await ask(request, abort.signal);
    const { model: answer, task_complexity, reasoning_required, tool_complexity } = result.answers;
    if (typeof answer?.choice !== "string") throw new Error("Laya response is missing the model choice");
    return {
      ...answer,
      confidence: choiceConfidence(answer),
      request,
      response: result,
      metrics: {
        taskComplexity: task_complexity.score / COMPLEXITY_MAX_SCORE,
        reasoningRequired: reasoning_required.score / COMPLEXITY_MAX_SCORE,
        toolComplexity: tool_complexity.score / COMPLEXITY_MAX_SCORE,
        contextSize: Math.min(contextTokens / CONTEXT_WINDOW_TOKENS, 1),
      },
      ms: Date.now() - started,
    };
  } catch (err) {
    log(`routing failed, keeping ${current}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(deadline);
  }
}
