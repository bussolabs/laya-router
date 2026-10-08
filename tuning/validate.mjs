// Checks Laya fine-tuning files: node tuning/validate.mjs [file.jsonl ...]
// Without arguments it checks examples.jsonl, dataset.jsonl and test.jsonl (when present).
import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const here = (name) => new URL(`./${name}`, import.meta.url).pathname;
const QUESTIONS = JSON.parse(readFileSync(here("questions.json"), "utf8"));
const TOLERANCE = 1e-6;

/** Option keys the gold distribution of a question must use, in order. */
function goldKeys(question) {
  if (question.type === "choice") return Object.keys(question.criteria);
  if (question.type === "score") return question.criteria.map((_, i) => String(i));
  if (question.type === "noul") return ["false", "true"];
  return null;
}

/** Problems with one line, as human-readable strings; empty when the line is valid. */
export function checkLine(text) {
  let row;
  try {
    row = JSON.parse(text);
  } catch (err) {
    return [`not valid JSON (${err.message})`];
  }
  if (row === null || typeof row !== "object") return ["not a JSON object"];

  const problems = [];
  if (row.state === undefined || row.state === null) problems.push("missing state");
  if (!isDeepStrictEqual(row.questions, QUESTIONS)) {
    problems.push("questions differ from tuning/questions.json (copy them verbatim)");
  }
  if (!row.gold || typeof row.gold !== "object") return [...problems, "missing gold"];

  const extra = Object.keys(row.gold).filter((id) => !(id in QUESTIONS));
  if (extra.length) problems.push(`gold has unknown questions: ${extra.join(", ")}`);

  for (const [id, question] of Object.entries(QUESTIONS)) {
    const gold = row.gold[id];
    if (!gold) {
      problems.push(`${id}: missing gold`);
      continue;
    }
    const keys = goldKeys(question);
    const probs = gold.probabilities ?? {};
    const got = Object.keys(probs);
    if (got.length !== keys.length || !keys.every((k) => k in probs)) {
      problems.push(`${id}: probabilities must have exactly the keys ${keys.join(", ")}`);
      continue;
    }
    if (!got.every((k) => typeof probs[k] === "number" && probs[k] >= 0 && probs[k] <= 1)) {
      problems.push(`${id}: every probability must be a number between 0 and 1`);
      continue;
    }
    const sum = got.reduce((total, k) => total + probs[k], 0);
    if (Math.abs(sum - 1) > TOLERANCE) problems.push(`${id}: probabilities sum to ${sum}, not 1`);

    const top = Math.max(...got.map((k) => probs[k]));
    const best = got.filter((k) => Math.abs(probs[k] - top) <= TOLERANCE);
    if (!keys.includes(gold.label)) problems.push(`${id}: label "${gold.label}" is not one of ${keys.join(", ")}`);
    else if (best.length > 1) problems.push(`${id}: tie between ${best.join(", ")}; give the right answer more weight`);
    else if (best[0] !== gold.label) problems.push(`${id}: label "${gold.label}" is not the most likely option ("${best[0]}")`);

    if (question.type === "score" && gold.score !== undefined) {
      const expected = got.reduce((total, k) => total + Number(k) * probs[k], 0);
      if (Math.abs(gold.score - expected) > 1e-3) problems.push(`${id}: score ${gold.score} should be ${expected.toFixed(6)}`);
    }
  }
  return problems;
}

const files = process.argv.length > 2
  ? process.argv.slice(2)
  : ["examples.jsonl", "dataset.jsonl", "test.jsonl"].map(here).filter(existsSync);

let failed = false;
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  let rows = 0;
  let bad = 0;
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    rows++;
    const problems = checkLine(line);
    if (!problems.length) return;
    bad++;
    for (const problem of problems) console.log(`${file}:${i + 1}: ${problem}`);
  });
  console.log(`${file}: ${rows} rows, ${bad} with problems`);
  if (bad) failed = true;
}
process.exitCode = failed ? 1 : 0;
