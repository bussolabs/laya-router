import { spawn as spawnProcess } from "node:child_process";
import { accessSync, closeSync, constants, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// One laya-serve per machine, shared by every laya-router and laya-compaction process. It is
// started on demand, detached so it outlives its caller, and unloads the model when idle.

export const DEFAULT_LOCAL_PORT = 8765;
export const LOCAL_MODEL = "multilingual";
export const LAYA_SERVE_PACKAGE = "laya[serve]==0.4.0";
export const CACHE_DIR = join(homedir(), ".cache", "laya-local");
export const LAUNCHER = join(dirname(dirname(fileURLToPath(import.meta.url))), "serve", "laya_serve.py");

const HEALTH_TIMEOUT_MS = 1000;
// A spawn holds the lock this long: other callers assume the server is still starting. Past it
// the lock is treated as stale, so a crashed start does not block local mode for good.
export const SPAWN_LOCK_STALE_MS = 120_000;

export const localBaseUrl = (env = process.env) =>
  `http://127.0.0.1:${env.LAYA_LOCAL_PORT || DEFAULT_LOCAL_PORT}`;

/** Whether a laya-serve answers `GET /health` at `baseUrl`. */
export async function isHealthy(baseUrl, fetcher = fetch) {
  try {
    const response = await fetcher(`${baseUrl}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Absolute path of an executable on PATH, or null. */
export function findOnPath(name, path = process.env.PATH ?? "") {
  const win = process.platform === "win32";
  const exts = win ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of path.split(win ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir, `${name}${ext}`);
      try {
        accessSync(file, constants.X_OK);
        return file;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null;
}

/**
 * Takes the spawn lock, or returns false when another caller holds a fresh one. The lock is
 * never released on purpose: it marks "a server is starting" for its whole staleness window.
 */
export function acquireSpawnLock(file, now = Date.now()) {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(file, "wx"));
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (now - statSync(file).mtimeMs < SPAWN_LOCK_STALE_MS) return false;
        unlinkSync(file);
      } catch {
        // Removed by another caller in the meantime; try to take it again.
      }
    }
  }
  return false;
}

/** Starts the shared laya-serve, detached, logging to `serve.log` in the cache dir. */
export function spawnServer({ env = process.env, cacheDir = CACHE_DIR, uv, spawn = spawnProcess }) {
  mkdirSync(cacheDir, { recursive: true });
  const log = openSync(join(cacheDir, "serve.log"), "a");
  const { LAYA_API_KEY, LAYA_URL, LAYA_MODEL, ...inherited } = env; // remote-only settings
  const serverEnv = {
    ...inherited,
    LAYA_HOST: "127.0.0.1",
    LAYA_PORT: String(env.LAYA_LOCAL_PORT || DEFAULT_LOCAL_PORT),
    LAYA_DEFAULT_MODEL: LOCAL_MODEL,
    LAYA_IDLE_UNLOAD_SECONDS: "900",
  };
  if (env.LAYA_MODEL_DIR) serverEnv.LAYA_CHECKPOINT = env.LAYA_MODEL_DIR;
  try {
    const child = spawn(
      uv,
      ["tool", "run", "--python", "3.12", "--from", LAYA_SERVE_PACKAGE, "python", LAUNCHER],
      { detached: true, stdio: ["ignore", log, log], env: serverEnv },
    );
    child.on?.("error", () => {}); // reported in serve.log or by the next health check
    child.unref?.();
  } finally {
    closeSync(log);
  }
}

/**
 * Makes sure the shared local laya-serve is running. Resolves true when it answers now, false
 * when it is being started (by this call or another one); never waits for it to boot.
 * Throws when `uv` is missing, since nothing else can start the server.
 */
export async function ensureLocalServer({
  env = process.env,
  fetch: fetcher = fetch,
  spawn = spawnProcess,
  cacheDir = CACHE_DIR,
  which = findOnPath,
  now = Date.now,
} = {}) {
  if (await isHealthy(localBaseUrl(env), fetcher)) return true;
  const uv = which("uv", env.PATH);
  if (!uv) {
    throw new Error(
      "uv is required to run Laya locally (it installs and starts laya-serve). " +
        "Install it from https://docs.astral.sh/uv/ or set LAYA_URL to a laya-serve server.",
    );
  }
  if (acquireSpawnLock(join(cacheDir, "spawn.lock"), now())) spawnServer({ env, cacheDir, uv, spawn });
  return false;
}
