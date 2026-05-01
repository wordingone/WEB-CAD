"""
Publish best v2 LoRA adapter to HuggingFace Hub as gemma-architect/cad-lora-v2.

Picks the adapter with the highest round-trip pass rate from
outputs/cad-lora-v2-*-summary.json. Requires HF_TOKEN env var (or
HUGGING_FACE_HUB_TOKEN). If absent, dumps the publish plan and exits 0.

Usage:
  HF_TOKEN=hf_... python src/train/publish_v2.py
  HF_TOKEN=hf_... python src/train/publish_v2.py --repo gemma-architect/cad-lora-v2
"""

import argparse
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / "outputs"


def find_best() -> tuple[Path | None, dict]:
    candidates = list(OUT_DIR.glob("cad-lora-v2-*-summary.json"))
    if not candidates:
        return None, {}
    rows = []
    for p in candidates:
        with p.open(encoding="utf-8") as f:
            s = json.load(f)
        s["_summary_path"] = str(p)
        s["_adapter_dir"] = s.get("adapter") or str(OUT_DIR / p.name.replace("-summary.json", ""))
        rows.append(s)
    best = max(rows, key=lambda r: (r.get("round_trip_pct", 0), r.get("api_clean", 0), r.get("parse_ok", 0)))
    return Path(best["_adapter_dir"]), best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="gemma-architect/cad-lora-v2")
    ap.add_argument("--private", action="store_true")
    args = ap.parse_args()

    adapter, summary = find_best()
    if adapter is None:
        print("no v2 summaries found in outputs/. Train first.", file=sys.stderr)
        sys.exit(2)
    print(f"best adapter: {adapter}")
    print(f"  parse_ok      : {summary.get('parse_ok')}/{summary.get('n_eval')}")
    print(f"  api_clean     : {summary.get('api_clean')}/{summary.get('n_eval')}")
    print(f"  round-trip %  : {summary.get('round_trip_pct'):.1f}")

    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if not token:
        print("\nHF_TOKEN not set — dumping publish plan only:", file=sys.stderr)
        plan = {
            "repo": args.repo,
            "private": args.private,
            "source_dir": str(adapter),
            "files_to_upload": [str(p.relative_to(adapter)) for p in adapter.rglob("*") if p.is_file() and "checkpoints" not in p.parts],
            "summary": summary,
            "next_step": "set HF_TOKEN, re-run this script",
        }
        plan_path = OUT_DIR / "cad-lora-v2-publish-plan.json"
        with plan_path.open("w", encoding="utf-8") as f:
            json.dump(plan, f, indent=2)
        print(f"plan written to {plan_path}")
        sys.exit(0)

    from huggingface_hub import HfApi, create_repo

    print(f"\npublishing to {args.repo} (private={args.private}) ...")
    create_repo(args.repo, token=token, exist_ok=True, private=args.private, repo_type="model")
    api = HfApi(token=token)
    api.upload_folder(
        folder_path=str(adapter),
        repo_id=args.repo,
        repo_type="model",
        ignore_patterns=["checkpoints/*", "*.log", "events.*"],
        commit_message="cad-lora-v2 — Gemma + replicad CAD adapter",
    )
    print("done.")


if __name__ == "__main__":
    main()
