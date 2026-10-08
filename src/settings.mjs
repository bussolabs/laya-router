import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AUTO_MODEL } from "./config.mjs";

export const USER_SETTINGS = join(homedir(), ".claude", "settings.json");

/**
 * The model saved as the user's default, ignoring a sentinel left behind by a session that
 * did not exit cleanly, which is not a preference worth restoring.
 */
export function readSavedModel(file = USER_SETTINGS) {
  try {
    const model = JSON.parse(readFileSync(file, "utf8")).model;
    return model === AUTO_MODEL ? undefined : model;
  } catch {
    return undefined;
  }
}

/**
 * Puts `previous` back if the settings file now holds the sentinel. Selecting a row with
 * Enter makes Claude Code save it as the default for new sessions, and a saved "laya-router"
 * would break plain `claude`, which has no proxy to resolve it. Anything other than an exact
 * sentinel match is left alone, so a real model chosen during the session survives. The file
 * is replaced by a rename, never truncated in place, and keeps its own permissions.
 */
export function restoreSavedModel(previous, file = USER_SETTINGS) {
  try {
    const settings = JSON.parse(readFileSync(file, "utf8"));
    if (settings.model !== AUTO_MODEL) return false;
    if (previous === undefined) delete settings.model;
    else settings.model = previous;
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: statSync(file).mode & 0o777 });
    renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}
