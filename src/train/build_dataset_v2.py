"""
v2 dataset assembly — combines all 5 buckets (400 base rows) into Gemma chat-format
train + eval files with deterministic augmentation.

Buckets per dataset/v2-spec.md §Composition:
- fixtures/tier1.jsonl          (50, reuse)
- fixtures/tier1-extra.jsonl    (50, D3)
- fixtures/tier2-curated.jsonl  (50, D3)
- fixtures/mined-extra.jsonl    (50, D3)
- data/v2-synthetic.jsonl       (200, D2 — already in messages-shape)

Augmentation (per spec): for each base pair generate 2-3 NL paraphrases via
deterministic template substitution (no LLM in the loop). Final train ≈ 1200,
eval ≈ 40 (no aug, held out before augmentation).

Output: data/train_v2.jsonl, data/eval_v2.jsonl
"""

import json
import random
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FIX = REPO / "fixtures"
DATA = REPO / "data"
OUT_DIR = DATA
OUT_DIR.mkdir(exist_ok=True)

SYSTEM_PROMPT = (
    "You are a parametric CAD assistant. Given a natural-language description "
    "of an architectural element or assembly, emit a JavaScript construction "
    "sequence using the replicad fluent API (drawRectangle, drawCircle, "
    "drawPolyline, sketchOnPlane, extrude, translate, rotate, fuse, cut). "
    "Output only the JS code, no commentary."
)

# ---------- loaders ----------

def _load_pair_shape(path: Path, src_tag: str) -> list[dict]:
    """fixtures/*.jsonl — {id, prompt, sequence, element, ops}."""
    out = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            out.append({"prompt": d["prompt"], "sequence": d["sequence"], "src": src_tag})
    return out


def _load_messages_shape(path: Path, src_tag: str) -> list[dict]:
    """data/v2-synthetic.jsonl — {messages: [system, user, assistant]}."""
    out = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            msgs = d["messages"]
            user = next(m["content"] for m in msgs if m["role"] == "user")
            asst = next(m["content"] for m in msgs if m["role"] == "assistant")
            out.append({"prompt": user, "sequence": asst, "src": src_tag})
    return out


# ---------- augmentation ----------

_NUM_WORDS = {
    1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six",
    7: "seven", 8: "eight", 9: "nine", 10: "ten", 11: "eleven", 12: "twelve",
}

def _paraphrase_numeric(text: str) -> str:
    """5m → 5 meters; replace one token per call to keep variants diverse."""
    # match like "5m" / "5.5m" / "0.3m" but not inside words
    def repl(m):
        n = m.group(1)
        return f"{n} meters"
    out = re.sub(r"\b(\d+(?:\.\d+)?)m\b", repl, text, count=1)
    return out


def _paraphrase_word(text: str) -> str:
    """5 meters → five meters when integer 1..12. Only applies when preceded
    by start-of-string, whitespace, or non-numeric punctuation — so '1.5 meters'
    is left alone (not turned into '1.five meters')."""
    def repl(m):
        n = int(m.group(1))
        word = _NUM_WORDS.get(n)
        if word is None:
            return m.group(0)
        return f"{word} {m.group(2)}"
    out = re.sub(r"(?<![\d.])(\d+)\s+(meters?|m)\b", repl, text, count=1)
    return out


_VERB_REPLACEMENTS = [
    (r"^Build\b", "Create"),
    (r"^Build\b", "Construct"),
    (r"^Place\b", "Position"),
    (r"^Make\b", "Create"),
    (r"^Erect\b", "Stand up"),
    (r"^Construct\b", "Build"),
    (r"^Design\b", "Build"),
]

def _paraphrase_verb(text: str, idx: int) -> str:
    """Imperative-verb swap. idx selects which replacement to try."""
    for i, (pat, sub) in enumerate(_VERB_REPLACEMENTS):
        if i != idx:
            continue
        new = re.sub(pat, sub, text, count=1)
        if new != text:
            return new
    return text


def augment(pair: dict) -> list[dict]:
    """Yield base pair + 2-3 deterministic paraphrases. Same JS sequence for all."""
    out = [pair]
    seen = {pair["prompt"]}
    candidates = [
        _paraphrase_numeric(pair["prompt"]),
        _paraphrase_word(_paraphrase_numeric(pair["prompt"])),
        _paraphrase_verb(pair["prompt"], 0),
        _paraphrase_verb(pair["prompt"], 1),
        _paraphrase_verb(pair["prompt"], 2),
    ]
    for c in candidates:
        if c and c not in seen and c != pair["prompt"]:
            seen.add(c)
            out.append({"prompt": c, "sequence": pair["sequence"], "src": pair["src"] + "+aug"})
        if len(out) >= 3:
            break
    return out


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

    buckets = [
        _load_pair_shape(FIX / "tier1.jsonl", "tier1"),
        _load_pair_shape(FIX / "tier1-extra.jsonl", "tier1_extra"),
        _load_pair_shape(FIX / "tier2-curated.jsonl", "tier2_curated"),
        _load_pair_shape(FIX / "mined-extra.jsonl", "mined_extra"),
        _load_messages_shape(DATA / "v2-synthetic.jsonl", "synthetic"),
    ]
    sizes = [len(b) for b in buckets]
    print(f"buckets: tier1={sizes[0]} tier1_extra={sizes[1]} tier2={sizes[2]} mined={sizes[3]} synthetic={sizes[4]}")

    all_pairs = [p for b in buckets for p in b]
    print(f"total base pairs: {len(all_pairs)}")

    # Stratified holdout: 10% per bucket → eval (no aug)
    eval_pairs = []
    train_seed = []
    for b in buckets:
        idxs = list(range(len(b)))
        random.shuffle(idxs)
        n_eval = max(1, len(b) // 10)
        eval_pairs.extend(b[i] for i in idxs[:n_eval])
        train_seed.extend(b[i] for i in idxs[n_eval:])

    print(f"eval (no aug): {len(eval_pairs)}")
    print(f"train seed (pre-aug): {len(train_seed)}")

    # Augment training
    train_pairs = []
    for p in train_seed:
        train_pairs.extend(augment(p))
    random.shuffle(train_pairs)
    print(f"train (post-aug): {len(train_pairs)}")

    with (OUT_DIR / "train_v2.jsonl").open("w", encoding="utf-8") as f:
        for p in train_pairs:
            f.write(json.dumps(to_chat(p)) + "\n")
    with (OUT_DIR / "eval_v2.jsonl").open("w", encoding="utf-8") as f:
        for p in eval_pairs:
            f.write(json.dumps(to_chat(p)) + "\n")

    print(f"wrote data/train_v2.jsonl ({len(train_pairs)}) + data/eval_v2.jsonl ({len(eval_pairs)})")


if __name__ == "__main__":
    main()
