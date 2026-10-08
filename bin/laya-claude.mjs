#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startProxy } from "../src/proxy.mjs";
import { warmUp } from "../src/router.mjs";
import { AUTO_MODEL } from "../src/config.mjs";
import { readSavedModel, restoreSavedModel } from "../src/settings.mjs";
import { writePrivate } from "../src/status.mjs";
import { LOG_FILE } from "../src/log.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

/**
 * Registers "Laya Router" as an extra row in Claude Code's /model picker and starts the session
 * on it. Claude Code sends the id verbatim because it does not validate model names behind a
 * custom base URL, which is what lets the proxy tell "route this" from "the user picked a
 * model". Capabilities are declared so Claude Code still composes thinking and effort for
 * the tiers that support them; the proxy strips what the routed model cannot accept.
 */
function autoModelEnv() {
  const env = {
    ANTHROPIC_CUSTOM_MODEL_OPTION: AUTO_MODEL,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "Laya Router",
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Route each turn to the cheapest model that can do it",
    ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES:
      "thinking,adaptive_thinking,interleaved_thinking,effort,max_effort",
    // Some Claude Code versions validate the model client-side before it reaches the proxy;
    // this defers to the API so "laya-router" can pass through for rewriting.
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
  };
  // ANTHROPIC_MODEL applies to this session only and is never written to settings, so the
  // default costs the user nothing permanent. A model they set themselves still wins.
  if (!process.env.ANTHROPIC_MODEL) env.ANTHROPIC_MODEL = AUTO_MODEL;
  return env;
}

/**
 * Claude Code saves a picker row chosen with Enter as the default for new sessions, so the
 * value from before this session is captured now and put back on the way out.
 */
const savedModelBefore = readSavedModel();

/**
 * Claude Code's UI shows the model it asked for, never the one the proxy routed to, so a
 * status line is the only way to surface the decision. `--settings` merges rather than
 * replaces, but a status line the user configured themselves still takes priority: theirs
 * is a deliberate choice and silently overwriting it would be worse than showing nothing.
 */
function statusLineArgs() {
  if (process.env.LAYA_NO_STATUSLINE) return [];
  for (const dir of [join(process.cwd(), ".claude"), join(homedir(), ".claude")]) {
    try {
      if (JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).statusLine) return [];
    } catch {
      // No settings file, or unreadable; nothing to preserve.
    }
  }
  // Passed as a file rather than inline JSON: on Windows the args go through a shell, and a
  // JSON string containing its own quotes does not survive that.
  const command = `"${process.execPath}" "${join(HERE, "laya-statusline.mjs")}"`;
  try {
    return ["--settings", writePrivate("settings.json", JSON.stringify({ statusLine: { type: "command", command } }))];
  } catch {
    return [];
  }
}

// Existing environment variables win, followed by project-local, then shared user-level.
for (const file of [join(process.cwd(), ".env"), join(homedir(), ".laya-router.env")]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Missing or unreadable; settings may still come from the real environment.
  }
}

/**
 * Finds the Claude Code executable on PATH. Resolving it here rather than leaning on the
 * shell means arguments are passed as an array (no quoting hazard, no DEP0190 warning) and
 * a missing install produces a useful message instead of a shell error. Older npm-based
 * installs are a `.cmd` shim, which Node still refuses to run without a shell.
 */
function resolveClaude() {
  const win = process.platform === "win32";
  const exts = win ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(win ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir.replace(/^"|"$/g, ""), `claude${ext}`);
      try {
        accessSync(file, constants.X_OK);
        return { file, shell: /\.(cmd|bat)$/i.test(file) };
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null;
}

const args = process.argv.slice(2);
args.push("--add-dir", ROOT);
const env = { ...process.env };

const claude = resolveClaude();
if (!claude) {
  process.stderr.write(
    "[laya] Claude Code is not installed, or `claude` is not on your PATH.\n" +
      "[laya] laya-claude runs the real Claude Code CLI; install it first:\n" +
      "[laya]   https://code.claude.com/docs/en/setup\n",
  );
  process.exit(1);
}

// Laya needs no key in local mode, so routing is always on: a Laya failure only keeps the
// current model (see src/policy.mjs), it never blocks the session.
{
  const { port, close } = await startProxy();
  // Starts the shared local Laya server now, so it is warm by the first prompt.
  const warning = await warmUp();
  if (warning) process.stderr.write(`[laya] ${warning}\n[laya] starting Claude Code; turns keep the current model\n`);
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  Object.assign(env, autoModelEnv());
  // `exit` alone is not reached by a signal, and a `kill` would leave the sentinel saved as
  // Claude Code's default. Ctrl+C is left to Claude Code, which reads it as "interrupt the turn".
  let tornDown = false;
  const teardown = () => {
    if (tornDown) return;
    tornDown = true;
    try {
      close();
    } catch {
      // A failing proxy close must not cost the settings restore.
    }
    restoreSavedModel(savedModelBefore);
  };
  process.on("exit", teardown);
  for (const [signal, code] of [["SIGTERM", 143], ["SIGHUP", 129]]) {
    process.on(signal, () => {
      teardown();
      process.exit(code);
    });
  }
  args.push(...statusLineArgs());
  if (process.env.LAYA_DEBUG && process.stdout.isTTY) {
    process.stderr.write(`[laya] routing decisions -> ${LOG_FILE}\n`);
  }
}

// On Windows a `.cmd` shim still needs a shell; a real executable does not.
const child = spawn(claude.file, claude.shell ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args, {
  stdio: "inherit",
  shell: claude.shell,
  env,
});

child.on("error", (err) => {
  process.stderr.write(`[laya] could not start Claude Code: ${err.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
