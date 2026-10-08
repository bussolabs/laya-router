import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSpawnLock,
  ensureLocalServer,
  LAUNCHER,
  localBaseUrl,
  SPAWN_LOCK_STALE_MS,
} from "../src/local-server.mjs";

const cacheDir = () => mkdtempSync(join(tmpdir(), "laya-local-test-"));
const healthy = async () => new Response("{\"status\":\"ok\"}", { status: 200 });
const refused = async () => {
  throw new TypeError("fetch failed");
};

function recordingSpawn() {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { on() {}, unref() {} };
  };
  return { calls, spawn };
}

test("the local server listens on 127.0.0.1:8765 unless LAYA_LOCAL_PORT is set", () => {
  assert.equal(localBaseUrl({}), "http://127.0.0.1:8765");
  assert.equal(localBaseUrl({ LAYA_LOCAL_PORT: "8766" }), "http://127.0.0.1:8766");
});

test("a running server is reused without spawning", async () => {
  const urls = [];
  const { calls, spawn } = recordingSpawn();
  const ready = await ensureLocalServer({
    env: { LAYA_LOCAL_PORT: "8766" },
    fetch: async (url) => {
      urls.push(url);
      return healthy();
    },
    spawn,
    cacheDir: cacheDir(),
    which: () => "/usr/bin/uv",
  });
  assert.equal(ready, true);
  assert.deepEqual(urls, ["http://127.0.0.1:8766/health"]);
  assert.equal(calls.length, 0);
});

test("a missing server is spawned detached through uv with the local settings", async () => {
  const dir = cacheDir();
  const { calls, spawn } = recordingSpawn();
  const ready = await ensureLocalServer({
    env: {
      PATH: "/bin",
      LAYA_MODEL_DIR: "/models/laya-ft",
      LAYA_API_KEY: "remote-only",
      LAYA_MODEL: "english",
    },
    fetch: refused,
    spawn,
    cacheDir: dir,
    which: () => "/opt/bin/uv",
  });

  assert.equal(ready, false, "the caller does not wait for the boot");
  assert.equal(calls.length, 1);
  const { command, args, options } = calls[0];
  assert.equal(command, "/opt/bin/uv");
  assert.deepEqual(args, ["tool", "run", "--python", "3.12", "--from", "laya[serve]==0.4.0", "python", LAUNCHER]);
  assert.equal(options.detached, true);
  assert.equal(options.env.LAYA_HOST, "127.0.0.1");
  assert.equal(options.env.LAYA_PORT, "8765");
  assert.equal(options.env.LAYA_DEFAULT_MODEL, "multilingual");
  assert.equal(options.env.LAYA_IDLE_UNLOAD_SECONDS, "900");
  assert.equal(options.env.LAYA_CHECKPOINT, "/models/laya-ft");
  assert.equal(options.env.PATH, "/bin");
  assert.equal("LAYA_API_KEY" in options.env, false, "a remote key must not lock the local server");
  assert.equal("LAYA_MODEL" in options.env, false);
  assert(existsSync(join(dir, "serve.log")));
  assert(existsSync(join(dir, "spawn.lock")));
});

test("without LAYA_MODEL_DIR the server keeps the built-in multilingual checkpoint", async () => {
  const { calls, spawn } = recordingSpawn();
  await ensureLocalServer({ env: {}, fetch: refused, spawn, cacheDir: cacheDir(), which: () => "uv" });
  assert.equal("LAYA_CHECKPOINT" in calls[0].options.env, false);
});

test("a second caller does not spawn while the first server is starting", async () => {
  const dir = cacheDir();
  const { calls, spawn } = recordingSpawn();
  const options = { env: {}, fetch: refused, spawn, cacheDir: dir, which: () => "uv" };
  await Promise.all([ensureLocalServer(options), ensureLocalServer(options), ensureLocalServer(options)]);
  assert.equal(calls.length, 1);
});

test("a stale spawn lock is taken over", () => {
  const dir = cacheDir();
  const lock = join(dir, "spawn.lock");
  writeFileSync(lock, "");
  assert.equal(acquireSpawnLock(lock), false);
  const old = (Date.now() - SPAWN_LOCK_STALE_MS - 1000) / 1000;
  utimesSync(lock, old, old);
  assert.equal(acquireSpawnLock(lock), true);
});

test("a missing uv is a clear error, not a silent failure", async () => {
  const { calls, spawn } = recordingSpawn();
  await assert.rejects(
    ensureLocalServer({ env: {}, fetch: refused, spawn, cacheDir: cacheDir(), which: () => null }),
    /uv is required to run Laya locally/,
  );
  assert.equal(calls.length, 0);
});
