// Writes tuning/questions.json: the exact questions laya-router sends to Laya, so training
// examples can be written against the same text. Run it again after changing src/config.mjs.
import { writeFileSync } from "node:fs";
import { availableTiers, QUESTIONS, questionForModels } from "../src/config.mjs";
import { claudeModels } from "../src/proxy.mjs";

// The `model` question lists the models of the user's account. Without a catalogue the router
// falls back to the default Claude tiers, which is what is exported here (Fable only when
// LAYA_ALLOW_FABLE=1, as at runtime).
const tiers = availableTiers();
const models = claudeModels([]).filter((model) => tiers.includes(model.tier));
const questions = { ...QUESTIONS, model: questionForModels(models) };

const file = new URL("./questions.json", import.meta.url);
writeFileSync(file, `${JSON.stringify(questions, null, 2)}\n`);
console.log(`wrote ${file.pathname} (${Object.keys(questions).length} questions, models: ${models.map((m) => m.id).join(", ")})`);
