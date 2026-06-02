"""
deep-capture-validate.py  —  fail-closed validator for avir/deep-capture/v1
Usage: python deep-capture-validate.py <session.json>

Exit 0 = VALID
Exit 1 = INVALID (prints all violations)

This validator enforces the structural constraints that JSON Schema alone cannot
fully express at runtime, including:
  - intent is non-empty and non-placeholder (FILL_IN etc.)
  - elevation_* captures have projection=parallel
  - haiku_verdict gate-authority (leo-only counts as authoritative pass)
  - mid-session snapshot linkage consistency
"""
import json, sys, hashlib, os

FILL_IN_VARIANTS = {"FILL_IN", "fill_in", "TODO", "todo", "", "FILL_IN: top-level design goal"}
ELEVATION_ROLES  = {"elevation_front", "elevation_right", "elevation_left", "elevation_back", "plan_top"}

def validate(record):
    errors = []

    # ── session ──────────────────────────────────────────────────────────────
    session = record.get("session", {})
    if not session.get("id"):
        errors.append("session.id is missing")
    if not session.get("captured_at"):
        errors.append("session.captured_at is missing")
    if session.get("schema_version") not in ("1.0.0", "1.0.1"):
        errors.append("session.schema_version unexpected: %s" % session.get("schema_version"))

    # ── event_log ─────────────────────────────────────────────────────────────
    event_log = record.get("event_log", [])
    snapshot_labels_declared = set()
    for ev in event_log:
        seq = ev.get("seq", "?")
        intent = ev.get("intent", "")
        if intent in FILL_IN_VARIANTS or len(str(intent).strip()) < 10:
            errors.append("event_log[seq=%s].intent is empty/placeholder: %r" % (seq, intent))
        label = ev.get("post_event_element_snapshot")
        if label:
            snapshot_labels_declared.add(label)
            if not ev.get("mutates_geometry"):
                errors.append("event_log[seq=%s] has post_event_element_snapshot=%r but mutates_geometry is not True" % (seq, label))

    # Check snapshot labels appear in element_catalog
    catalog_labels = set()
    for elem in record.get("element_catalog", []):
        sl = elem.get("snapshot_label")
        if sl:
            catalog_labels.add(sl)
    for label in snapshot_labels_declared:
        if label not in catalog_labels:
            errors.append("event_log references snapshot_label=%r but no element_catalog entry has it" % label)

    # ── element_catalog ───────────────────────────────────────────────────────
    element_catalog = record.get("element_catalog", [])
    if not element_catalog:
        errors.append("element_catalog is empty — no geometry captured")
    seen_ids = {}
    for elem in element_catalog:
        eid = elem.get("id", "")
        sl  = elem.get("snapshot_label")
        key = (eid, sl)
        if key in seen_ids:
            errors.append("element_catalog duplicate id=%r snapshot_label=%r" % (eid, sl))
        seen_ids[key] = True
        if not elem.get("geometry", {}).get("bbox"):
            errors.append("element_catalog[id=%r].geometry.bbox missing" % eid)
        ifc = elem.get("ifc_class", "")
        if not ifc:
            errors.append("element_catalog[id=%r].ifc_class missing" % eid)

    # ── captures ─────────────────────────────────────────────────────────────
    captures = record.get("captures", [])
    if not captures:
        errors.append("captures is empty — no visual evidence")
    for cap in captures:
        cid  = cap.get("id", "?")
        role = cap.get("role", "")
        view = cap.get("view", {})
        proj = view.get("projection", "")

        # ENFORCE: elevation/plan roles MUST have parallel projection
        if role in ELEVATION_ROLES and proj != "parallel":
            errors.append(
                "captures[id=%r] role=%r requires projection=parallel but got %r — "
                "perspective elevations are structurally INVALID (fixes #451 gap)" % (cid, role, proj)
            )

        # Verify file exists and sha256_prefix matches
        path = cap.get("path", "")
        if path and os.path.exists(path):
            sha_prefix = cap.get("sha256_prefix", "")
            if sha_prefix:
                with open(path, "rb") as f:
                    actual = hashlib.sha256(f.read()).hexdigest()[:12]
                if actual != sha_prefix:
                    errors.append("captures[id=%r] sha256_prefix mismatch: recorded=%r actual=%r" % (cid, sha_prefix, actual))
        elif path and not os.path.exists(path):
            errors.append("captures[id=%r] file not found: %s" % (cid, path))

        # Gate-authority check
        verdict = cap.get("haiku_verdict")
        if verdict and verdict.get("pass"):
            evaluator = verdict.get("evaluator", "")
            is_auth = verdict.get("is_gate_authoritative", False)
            if evaluator != "leo" and is_auth:
                errors.append(
                    "captures[id=%r] haiku_verdict.is_gate_authoritative=true but evaluator=%r — "
                    "only leo's Haiku is gate-authoritative" % (cid, evaluator)
                )
            if evaluator != "leo" and not is_auth and verdict.get("pass"):
                pass  # advisory self-Haiku — allowed, just not authoritative

    return errors


def main():
    if len(sys.argv) < 2:
        print("Usage: python deep-capture-validate.py <session.json>")
        sys.exit(1)
    path = sys.argv[1]
    with open(path, "r", encoding="utf-8") as f:
        record = json.load(f)

    errors = validate(record)
    if errors:
        print("VALIDATION FAILED — %d error(s):" % len(errors))
        for i, e in enumerate(errors, 1):
            print("  [%d] %s" % (i, e))
        sys.exit(1)
    else:
        n_events  = len(record.get("event_log", []))
        n_elems   = len(record.get("element_catalog", []))
        n_caps    = len(record.get("captures", []))
        leo_gates = sum(
            1 for c in record.get("captures", [])
            if (c.get("haiku_verdict") or {}).get("evaluator") == "leo"
            and (c.get("haiku_verdict") or {}).get("pass")
        )
        print("VALID — events=%d elements=%d captures=%d leo_gate_passes=%d" % (
            n_events, n_elems, n_caps, leo_gates
        ))
        sys.exit(0)


if __name__ == "__main__":
    main()
