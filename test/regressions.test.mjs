// Regressions for bugs reported upstream on gargpratyush/jev-router that also affected this port.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newTurnPrompt, startProxy, estimateTokens } from "../src/proxy.mjs";
import { codexModels, startCodexProxy } from "../src/codex-proxy.mjs";
import { resolveCodex } from "../src/codex-cli.mjs";
import { detectOverride, decide } from "../src/policy.mjs";
import { restoreSavedModel } from "../src/settings.mjs";
import { writePrivate, STATUS_DIR } from "../src/status.mjs";

const tools = [{ name: "Bash" }];

async function upstreamServer(t, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length) seen.push(JSON.parse(Buffer.concat(chunks)));
      handler(req, res);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { seen, url: `http://127.0.0.1:${server.address().port}` };
}

const jsonReply = (req, res) => {
  res.setHeader("content-type", "application/json");
  res.end('{"id":"msg_1","type":"message"}');
};

// #18, #28, #48, #58: Claude Code appends hook output and the environment block as a trailing
// `system` message, so the user turn is no longer the last message.
test("a user turn followed by trailing system messages is still a new turn", () => {
  const body = {
    tools,
    messages: [
      { role: "user", content: [{ type: "text", text: "<system-reminder>ctx</system-reminder>" }, { type: "text", text: "say ok" }] },
      { role: "system", content: [{ type: "text", text: "SessionStart:startup hook success" }] },
      { role: "system", content: "# Environment" },
    ],
  };
  assert.equal(newTurnPrompt(body), "say ok");
});

test("trailing system messages do not turn a continuation or an assistant reply into a turn", () => {
  const continuation = {
    tools,
    messages: [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      { role: "system", content: "hook" },
    ],
  };
  const reply = { tools, messages: [{ role: "assistant", content: "done" }, { role: "system", content: "hook" }] };
  assert.equal(newTurnPrompt(continuation), null);
  assert.equal(newTurnPrompt(reply), null);
});

// #59: the cache-rebuild guard blocked the downgrade on the first turn, when no cache exists.
test("the first turn of a conversation may downgrade however large its context", async (t) => {
  const upstream = await upstreamServer(t, jsonReply);
  const { port, close } = await startProxy({
    upstreamURL: upstream.url,
    route: async () => ({ choice: "claude-haiku-4-5-20251001", confidence: 0.9, ms: 1 }),
  });
  t.after(close);
  const send = (messages) =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "laya-router", tools, messages }),
    });

  const opening = { role: "user", content: `${"x".repeat(160_000)} fix the typo ${Date.now()}` };
  await send([opening]);
  assert.equal(upstream.seen[0].model, "claude-haiku-4-5-20251001");
});

// #41: a base64 image was counted by its encoded length, so one screenshot read as ~1M tokens.
test("images are estimated by their real token cost, not their base64 length", () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(4_000_000) } };
  const tokens = estimateTokens([{ role: "user", content: [image, { type: "text", text: "what is this?" }] }]);
  assert(tokens < 10_000, `estimated ${tokens} tokens`);
});

// #42: a model whose context window cannot hold the request must not be offered.
test("models too small for the request are not offered to Laya", async (t) => {
  const upstream = await upstreamServer(t, (req, res) => {
    if (req.url.startsWith("/v1/models")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({
        data: [
          { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", max_input_tokens: 200_000 },
          { id: "claude-sonnet-5", display_name: "Claude Sonnet 5", max_input_tokens: 1_000_000 },
        ],
      }));
    }
    jsonReply(req, res);
  });
  let offered;
  const { port, close } = await startProxy({
    upstreamURL: upstream.url,
    route: async ({ models }) => {
      offered = models.map((model) => model.id);
      return { choice: "claude-sonnet-5", confidence: 0.9, ms: 1 };
    },
  });
  t.after(close);
  await fetch(`http://127.0.0.1:${port}/v1/models`).then((r) => r.json());
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "laya-router",
      tools: [{ name: "Big", description: "y".repeat(1_000_000) }],
      messages: [{ role: "user", content: "what is 2+2?" }],
    }),
  });
  assert.deepEqual(offered, ["claude-sonnet-5"]);
});

// #49: several catalog models in one tier split Laya's vote, so confidence stayed low.
test("Codex offers Laya one model per tier, preferring the configured one", () => {
  const catalog = new Map(
    ["gpt-5.6-luna", "gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-sol"].map((slug) => [slug, { slug }]),
  );
  const ids = codexModels(catalog).map((model) => model.id);
  assert.deepEqual(ids, ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]);
});

// #54: each upstream chunk was decoded on its own, corrupting characters split across chunks.
test("routed Codex streams keep UTF-8 characters split across chunks", async (t) => {
  const first = 'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n';
  const delta = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ciao مرحبا 💡"}\n\n';
  const bytes = Buffer.from(first + delta);
  for (const cut of [bytes.indexOf(Buffer.from("مرحبا")) + 1, bytes.indexOf(Buffer.from("💡")) + 2]) {
    let releaseTail;
    const upstream = await upstreamServer(t, (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      releaseTail = () => res.end(bytes.subarray(cut));
      res.write(bytes.subarray(0, cut));
    });
    const { port, close } = await startCodexProxy({
      apiBaseURL: upstream.url,
      route: async () => ({ choice: "gpt-5.6-sol", confidence: 0.99 }),
    });
    t.after(close);
    const text = await new Promise((resolve, reject) => {
      const request = http.request(
        `http://127.0.0.1:${port}/responses`,
        { method: "POST", headers: { "content-type": "application/json" } },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => {
            chunks.push(chunk);
            const finish = releaseTail;
            releaseTail = null;
            finish?.();
          });
          response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          response.on("error", reject);
        },
      );
      request.on("error", reject);
      request.end(JSON.stringify({
        model: "laya-router",
        input: [{ type: "additional_tools", role: "developer", tools: [] }, { role: "user", content: "say hi in Arabic" }],
      }));
    });
    assert(text.includes("[Laya] routed this turn"));
    assert(text.endsWith(delta), `split at byte ${cut}: ${text}`);
  }
});

// #31: an open connection kept the proxy, and so laya-codex exec, alive after Codex exited.
test("closing a proxy also closes connections with a response in flight", async (t) => {
  const upstream = await upstreamServer(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: ping\ndata: {}\n\n"); // never ends
  });
  const starts = [
    () => startProxy({ upstreamURL: upstream.url }),
    () => startCodexProxy({ apiBaseURL: upstream.url }),
  ];
  for (const [i, start] of starts.entries()) {
    const { port, close } = await start();
    const path = i === 0 ? "/v1/messages" : "/responses";
    const closed = new Promise((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port, path, method: "POST" }, (response) => {
        response.once("data", () => close());
        response.on("close", () => resolve("closed"));
      });
      request.on("error", () => resolve("closed"));
      request.end("{}");
    });
    const outcome = await Promise.race([closed, new Promise((r) => setTimeout(r, 1000, "open"))]);
    assert.equal(outcome, "closed", `${path} kept its connection open after close()`);
  }
});

// #30: on Windows the PowerShell shim was preferred over codex.cmd and hung.
test("on Windows codex.cmd is preferred over the PowerShell shim", () => {
  const dir = mkdtempSync(join(tmpdir(), "laya-codex-bin-"));
  for (const name of ["codex.ps1", "codex.cmd"]) writeFileSync(join(dir, name), "");
  const found = resolveCodex({ platform: "win32", path: dir });
  assert.equal(found.file, join(dir, "codex.cmd"));
});

// PR #63: a web page could reach the loopback proxy through DNS rebinding or a cross-site POST.
test("the proxies refuse requests that do not come from a loopback origin", async (t) => {
  let routed = 0;
  const route = async () => {
    routed++;
    return null;
  };
  for (const start of [() => startProxy({ route }), () => startCodexProxy({ route })]) {
    const { port, close } = await start();
    t.after(close);
    const post = (headers) =>
      new Promise((resolve, reject) => {
        const request = http.request(
          { host: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "content-type": "text/plain", ...headers } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        request.on("error", reject);
        request.end(JSON.stringify({ model: "laya-router", tools, messages: [{ role: "user", content: "hi" }] }));
      });
    assert.equal(await post({ host: `evil.example:${port}` }), 403);
    assert.equal(await post({ host: `127.0.0.1:${port}`, origin: "https://evil.example" }), 403);
  }
  assert.equal(routed, 0);
});

// PR #57: the --settings file handed to Claude Code was world-readable, and restoring the user's
// settings truncated the file in place.
test("private files are written owner-only", { skip: process.platform === "win32" }, () => {
  const file = writePrivate("settings.json", "{}");
  assert.equal(file, join(STATUS_DIR, "settings.json"));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(STATUS_DIR).mode & 0o777, 0o700);
});

test("restoring the saved model keeps the settings file's mode and content intact", { skip: process.platform === "win32" }, () => {
  const file = join(mkdtempSync(join(tmpdir(), "laya-settings-")), "settings.json");
  writeFileSync(file, JSON.stringify({ model: "laya-router", theme: "dark" }), { mode: 0o600 });
  assert.equal(restoreSavedModel("claude-opus-5", file), true);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { model: "claude-opus-5", theme: "dark" });
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

// PR #65: an override phrase anywhere in the prompt switched tiers, including text the user only
// quoted or the agent read in ("deal with strong typing" meant Opus).
test("only a prompt that is exactly an override command switches tiers", () => {
  assert.equal(detectOverride("  use opus  "), "opus");
  assert.equal(detectOverride("Use Haiku"), "haiku");
  assert.equal(detectOverride("deal with strong typing in the parser"), null);
  assert.equal(detectOverride("the README says to use fable for this migration"), null);
  const out = decide({
    prompt: "please use haiku for this refactor",
    laya: { choice: "opus", confidence: 0.9 },
    current: "sonnet",
    available: ["haiku", "sonnet", "opus"],
  });
  assert.equal(out.tier, "opus");
});
