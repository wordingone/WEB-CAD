"""
Combine hand-written Spike A pairs (fixtures/tier1.jsonl) with mined Spike B
pairs (fixtures/spike-b-all.jsonl) into a single Gemma chat-format dataset.

Output: data/train.jsonl, data/eval.jsonl
Format: {"messages": [{"role":"user","content":...},{"role":"assistant","content":...}]}
"""

import json
import random
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TIER1 = REPO / "fixtures/tier1.jsonl"
SPIKE_B = REPO / "fixtures/spike-b-all.jsonl"
OUT_DIR = REPO / "data"
OUT_DIR.mkdir(exist_ok=True)

SYSTEM_PROMPT = (
    "You are a parametric CAD assistant. Given a natural-language description "
    "of an architectural element or assembly, emit a JavaScript construction "
    "sequence using the replicad fluent API (drawRectangle, drawCircle, "
    "drawPolyline, sketchOnPlane, extrude, translate, rotate, fuse, cut). "
    "Output only the JS code, no commentary."
)


def load_tier1() -> list[dict]:
    pairs = []
    with TIER1.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            pairs.append({"prompt": d["prompt"], "sequence": d["sequence"], "src": "tier1"})
    return pairs


def load_spike_b() -> list[dict]:
    pairs = []
    seen = set()
    with SPIKE_B.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            r = d.get("representation") or {}
            sig_payload = {k: v for k, v in r.items() if k != "placement"}
            sig = (d.get("elementType"), r.get("kind"), json.dumps(sig_payload, sort_keys=True))
            if sig in seen:
                continue
            seen.add(sig)
            for variant in d.get("nl_variants", [d.get("nl")]):
                if not variant:
                    continue
                pairs.append({"prompt": variant, "sequence": d["sequence"], "src": "spike_b"})
    return pairs


def to_chat(pair: dict) -> dict:
    return {
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": pair["prompt"]},
            {"role": "assistant", "content": pair["sequence"]},
        ]
    }


def main():
    random.seed(42)
    tier1 = load_tier1()
    spike_b = load_spike_b()
    print(f"tier1 pairs: {len(tier1)}")
    print(f"spike-b pairs (deduped + variants): {len(spike_b)}")

    all_pairs = tier1 + spike_b
    random.shuffle(all_pairs)
    n_eval = max(5, len(all_pairs) // 10)
    eval_pairs = all_pairs[:n_eval]
    train_pairs = all_pairs[n_eval:]

    with (OUT_DIR / "train.jsonl").open("w", encoding="utf-8") as f:
        for p in train_pairs:
            f.write(json.dumps(to_chat(p)) + "\n")
    with (OUT_DIR / "eval.jsonl").open("w", encoding="utf-8") as f:
        for p in eval_pairs:
            f.write(json.dumps(to_chat(p)) + "\n")

    print(f"wrote {len(train_pairs)} train + {len(eval_pairs)} eval")


if __name__ == "__main__":
    main()
