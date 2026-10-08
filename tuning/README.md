# Fine-tuning Laya for laya-router

The Laya checkpoints are generic decision models: they were not trained to pick a coding model.
This folder lets you teach one with your own examples, then plug it back into the router.

## What is here

| File | What it is |
| --- | --- |
| `questions.json` | The exact questions the router sends to Laya. Generated, do not edit by hand. |
| `export-questions.mjs` | Regenerates `questions.json` from `src/config.mjs` (`npm run tuning:questions`). |
| `examples.jsonl` | 30 hand-written, synthetic examples. Read them to learn the format. |
| `dataset.jsonl` | Empty. Your training examples go here. |
| `validate.mjs` | Checks every line of a file (`npm run tuning:validate`). |

All examples here are invented. None comes from a real session, so the folder is safe to
publish. Keep it that way: write your own cases instead of pasting real prompts that may hold
names, paths, customer data or secrets.

## The format

A `.jsonl` file has **one example per line**. Each line is a complete JSON object with three
parts:

- `state`: the situation, with exactly the shape the router sends at runtime:

  ```json
  {
    "request": "fix the typo 'recieve' in README.md",
    "session": { "current_model": "claude-sonnet-5", "context_tokens": 900 },
    "environment": { "available_models": ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5"] }
  }
  ```

  `current_model` is the model the conversation is on, `context_tokens` a rough size of the
  conversation so far (characters / 4).
- `questions`: a verbatim copy of `questions.json`. Same words in every example and in
  production, or the model learns a different question from the one it will be asked.
- `gold`: the right answer for each question, same keys as `questions`.

### Writing `gold`

| Question | Type | Keys of `probabilities` |
| --- | --- | --- |
| `task_complexity`, `reasoning_required`, `tool_complexity` | `score` | `"0"` … `"9"` (None … Extreme) |
| `model` | `choice` | the model ids in `questions.json` |

Each answer has:

- `label`: the right option. It must be the one with the highest probability.
- `probabilities`: one number per key, summing to 1.
  - Sure answer: `1.0` on the right one, `0.0` elsewhere.
  - Borderline case: split it, for example `0.6` / `0.4`. The model learns how sure to be, and
    the router uses that confidence (low confidence never downgrades).
- `score` (score questions only): the expected level, `sum(level × probability)`. Optional for
  training, used by the evaluation cells of the Kaggle notebook.
- `type`: the question type. Optional, kept for parity with the public benchmark.

The examples put 0.8 on the chosen score level and 0.2 on its neighbours: a level is a
judgement, not an exact fact.

### What the `model` choice means

Pick the **cheapest model that can finish the request in one pass**:

- Haiku: trivial or mechanical work (typos, renames, running one command, factual questions).
- Sonnet: ordinary, well-bounded engineering (a specified function, a test, a known local bug).
- Opus: hard reasoning, ambiguity or high blast radius (unknown-cause bugs, design, security,
  concurrency, migrations).

Short follow-ups ("yes, go ahead", "do the same for the other files") depend on the
conversation: the prompt alone is ambiguous, so split the probabilities and lean on the
current model.

## Rules for good examples

- **How many:** start with a few hundred. The public benchmark uses 1,200 cases.
- **Balanced:** roughly as many cases per model as you expect in real use, and every model
  present.
- **Varied:** different languages, project types, prompt lengths, current models and context
  sizes. Mix English and the language you actually write prompts in.
- **Hold out about 20%** in `test.jsonl`, never used for training. It tells you whether the
  fine-tuned model is really better.
- **Same questions everywhere.** If you change `src/config.mjs` (tiers, wording) or use other
  models, run `npm run tuning:questions` and update your examples. The `model` options are the
  default Claude tiers the router uses before it reads your account's catalogue; with
  `LAYA_ALLOW_FABLE=1` Fable is included. When the account's catalogue lists other model ids,
  the router asks with those ids and display names instead, so train with the ids you will
  actually route between.

Check the files before training:

```bash
npm run tuning:validate                         # examples.jsonl, dataset.jsonl, test.jsonl
node tuning/validate.mjs path/to/other.jsonl    # any other file
```

## Train

You need Python 3.10+ and the `laya` package. The JSONL rows above are the input format of
Laya's own trainer (`{state, questions, gold}`), so no conversion is needed.

### Option A: `laya-train` (Mac with Apple silicon, Linux, or any GPU)

```bash
python -m venv .venv && source .venv/bin/activate
pip install laya

# Inspect the data without loading weights
laya-train --data tuning/dataset.jsonl --dry-run

# Train; --base multilingual for prompts that are not only English
laya-train --data tuning/dataset.jsonl --eval tuning/test.jsonl \
  --base multilingual --out ./laya-router-ft
```

`--device` defaults to `auto` (CUDA, then Apple `mps`, then CPU). Other useful flags:
`--epochs` (default 4), `--loss soft-ce`, `--shuffle-options` (shuffles choice options each
epoch so the model does not learn their position). `--eval` prints before/after metrics on the
held-out file. The result loads with `laya.load("./laya-router-ft")`.

The upstream script `notebooks/laya_finetune_typed_decisions_mps.py` wraps the same trainer
(`laya.train.finetune`) for the public benchmark; `laya-train` is the shorter path for your
own file.

### Option B: Kaggle notebook (free 2× T4 GPU)

1. Open the notebook and import it into Kaggle (File → Import Notebook, paste the link):
   https://github.com/NandhaKishorM/laya/blob/main/notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb
2. In the right panel: **Accelerator = GPU T4 x2**, **Internet = On**. Upload `dataset.jsonl`
   with **Add Input → Upload** (for example as `laya-router-data`).
3. In the cell "3. Download & Preprocess Data", replace `ds_train = load_dataset(...)` and the
   `for row in ds_train:` loop with:

   ```python
   rows = [json.loads(line) for line in open("/kaggle/input/laya-router-data/dataset.jsonl") if line.strip()]

   items = []
   for row in rows:
       state, questions, gold = row["state"], row["questions"], row["gold"]
       for qid, q in questions.items():
           if qid in gold:
               it = build_training_item(state, q, gold[qid])
               if it:
                   items.append(it)
   ```

   The `/kaggle/input/...` path depends on the name you gave the upload; Kaggle shows it in the
   right panel. For non-English prompts, replace `model_dir = snapshot_download(MODEL_ID)` with:

   ```python
   model_dir = os.path.join(snapshot_download(MODEL_ID, allow_patterns=["multilingual/*"]), "multilingual")
   ```

4. Run the cells up to **5 (Launch Multi-GPU Fine-Tuning)**. The model is written to
   `/kaggle/working/laya_finetuned_typed_decisions`.
5. Cells 6 and 7 evaluate on the public English benchmark, not on your data. Skip them, or load
   your `test.jsonl` the same way as in step 3.
6. Cell 8 (push to Hugging Face): set `NEW_REPO` to a repo of **yours**. The default is the
   authors' repo.

## Use the fine-tuned model

The trainer writes a checkpoint directory (`model.safetensors`, `rl_agent_config.json`,
`encoder/`, `tokenizer/`). laya-router serves it as is, no conversion needed.

### On this machine: `LAYA_MODEL_DIR`

In `~/.laya-router.env`:

```bash
LAYA_MODEL_DIR=/path/to/laya-router-ft
```

The shared local server loads it in place of the built-in multilingual model. A server that is
already running keeps its model: stop it with `pkill -f laya_serve.py`, and the next
`laya-claude` / `laya-codex` starts it again with your checkpoint.

### On a server: `LAYA_URL`

Copy `serve/laya_serve.py` and the checkpoint to the server, then:

```bash
LAYA_HOST=0.0.0.0 LAYA_PORT=8000 LAYA_API_KEY=change-me LAYA_CHECKPOINT=/path/to/laya-router-ft \
  uv tool run --python 3.12 --from "laya[serve]==0.4.0" python laya_serve.py
```

and on your machine, in `~/.laya-router.env`:

```bash
LAYA_URL=https://your-server:8000
LAYA_API_KEY=change-me
LAYA_MODEL=multilingual
```

`LAYA_MODEL=multilingual` makes sure every request reaches your checkpoint, which replaces the
multilingual one on that server. Put the server behind HTTPS if it is reachable from outside.

## Not verified

These steps come from the upstream code and docs; they were not run end to end here:

- `laya-train` on this dataset (options read from `laya/train_cli.py`).
- The Kaggle edits in step 3, in particular the multilingual `model_dir` line.
- Serving a checkpoint trained with `laya-train` through `LAYA_CHECKPOINT`: the launcher was
  checked with a local checkpoint directory, not with one produced from this dataset.
