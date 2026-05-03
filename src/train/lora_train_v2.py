"""
v2 LoRA training — Gemma E2B + 4b-it via Unsloth QLoRA.

Inputs:  data/train_v2.jsonl, data/eval_v2.jsonl
Output:  outputs/cad-lora-v2-{model_tag}/

Run sequentially. Pick model via env GEMMA_V2_MODEL ∈ {"4b", "e2b"}; default "4b".
"""

import json
import os
import sys
from pathlib import Path

os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")
os.environ.setdefault("UNSLOTH_COMPILE_DISABLE", "1")
os.environ.setdefault("CC", "C:/Users/Admin/bin/gcc.exe")

import unsloth  # noqa: F401
from unsloth import FastModel
from unsloth.chat_templates import get_chat_template, train_on_responses_only

from datasets import load_dataset
from trl import SFTTrainer, SFTConfig

REPO = Path(__file__).resolve().parents[2]
TRAIN = REPO / "data/train_v2.jsonl"
EVAL = REPO / "data/eval_v2.jsonl"

MODEL_VARIANTS = {
    "4b": ("unsloth/gemma-3-4b-it-unsloth-bnb-4bit", "4b-it"),
    "e2b": ("unsloth/gemma-3n-E2B-it", "e2b-it"),
}

variant_key = os.environ.get("GEMMA_V2_MODEL", "4b").lower()
if variant_key not in MODEL_VARIANTS:
    print(f"unknown GEMMA_V2_MODEL={variant_key}, valid={list(MODEL_VARIANTS)}", file=sys.stderr)
    sys.exit(2)

MODEL_NAME, TAG = MODEL_VARIANTS[variant_key]
OUTPUT_DIR = REPO / f"outputs/cad-lora-v2-{TAG}"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
MAX_SEQ = 2048

print(f"variant={variant_key} model={MODEL_NAME} → {OUTPUT_DIR}")

print(f"loading {MODEL_NAME} ...")
_load_kwargs = {
    "model_name": MODEL_NAME,
    "max_seq_length": MAX_SEQ,
    "load_in_4bit": True,
    "full_finetuning": False,
}
# Gemma-3n-E2B includes a vision tower (TimmWrapperModel) which under
# transformers >= 5.3.0.dev0 + torch flex_attention raises ValueError on
# init. Force eager attention for E2B; 4b-it loads cleanly under default.
# Discovered 2026-05-03 on the first e2b train attempt.
if variant_key == "e2b":
    _load_kwargs["attn_implementation"] = "eager"
model, tokenizer = FastModel.from_pretrained(**_load_kwargs)

model = FastModel.get_peft_model(
    model,
    finetune_vision_layers=False,
    finetune_language_layers=True,
    finetune_attention_modules=True,
    finetune_mlp_modules=True,
    r=16,
    lora_alpha=16,
    lora_dropout=0,
    bias="none",
    random_state=42,
)

tokenizer = get_chat_template(tokenizer, chat_template="gemma-3")


def to_text(example):
    text = tokenizer.apply_chat_template(
        example["messages"],
        tokenize=False,
        add_generation_prompt=False,
    )
    return {"text": text}


train_ds = load_dataset("json", data_files=str(TRAIN), split="train").map(to_text)
eval_ds = load_dataset("json", data_files=str(EVAL), split="train").map(to_text)
print(f"train rows: {len(train_ds)}  eval rows: {len(eval_ds)}")

trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=train_ds,
    eval_dataset=eval_ds,
    args=SFTConfig(
        dataset_text_field="text",
        max_seq_length=MAX_SEQ,
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,
        warmup_steps=5,
        num_train_epochs=3,
        learning_rate=2e-4,
        fp16=False,
        bf16=True,
        logging_steps=5,
        optim="adamw_8bit",
        weight_decay=0.01,
        lr_scheduler_type="linear",
        seed=42,
        output_dir=str(OUTPUT_DIR / "checkpoints"),
        report_to="none",
        eval_strategy="epoch",
        save_strategy="epoch",
        save_total_limit=1,
    ),
)

trainer = train_on_responses_only(
    trainer,
    instruction_part="<start_of_turn>user\n",
    response_part="<start_of_turn>model\n",
)

print("starting training ...")
stats = trainer.train()
print(f"final train loss: {stats.training_loss:.4f}")

print(f"saving adapter to {OUTPUT_DIR}")
model.save_pretrained(str(OUTPUT_DIR))
tokenizer.save_pretrained(str(OUTPUT_DIR))

with (OUTPUT_DIR / "train-stats.json").open("w") as f:
    json.dump(
        {
            "model": MODEL_NAME,
            "tag": TAG,
            "train_loss": stats.training_loss,
            "metrics": stats.metrics,
            "n_train": len(train_ds),
            "n_eval": len(eval_ds),
        },
        f,
        indent=2,
    )

print("done.")
