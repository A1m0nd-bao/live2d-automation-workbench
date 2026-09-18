#!/usr/bin/env python3
"""Score a Live2D runtime against a small, reusable interaction contract.

This is deliberately a gate, not an auto-rigger. It answers whether a model
can enter the MVP motion pipeline, which actions are safe to generate, and
which missing abilities should trigger graceful degradation.

Usage:
  python3 character_contract.py /path/to/model-or-runtime --preset gentle
  python3 character_contract.py /path/to/model3.json --write-profile profile.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROLE_PATTERNS = {
    "headYaw": [r"param.*angle.*x", r"head.*(yaw|turn|x)", r"face.*x"],
    "headPitch": [r"param.*angle.*y", r"head.*(pitch|tilt|y)", r"face.*y"],
    "headRoll": [r"param.*angle.*z", r"head.*(roll|z)", r"face.*z"],
    "bodyYaw": [r"param.*body.*angle.*x", r"body.*(yaw|turn|x)"],
    "bodyPitch": [r"param.*body.*angle.*y", r"body.*(pitch|tilt|y)"],
    "bodyRoll": [r"param.*body.*angle.*z", r"body.*(roll|z)"],
    "eyeLeftOpen": [r"param.*eye.*l.*open", r"left.*eye.*open", r"eye.*left.*open"],
    "eyeRightOpen": [r"param.*eye.*r.*open", r"right.*eye.*open", r"eye.*right.*open"],
    "eyeBallX": [r"param.*eye(ball)?\s*x", r"eye.*(ball|gaze).*(x|horizontal)"],
    "eyeBallY": [r"param.*eye(ball)?\s*y", r"eye.*(ball|gaze).*(y|vertical)"],
    "browLeftY": [r"param.*brow.*l.*y", r"left.*brow.*(y|up|down)"],
    "browRightY": [r"param.*brow.*r.*y", r"right.*brow.*(y|up|down)"],
    "mouthOpen": [r"param.*mouth.*open", r"param.*mouth.*open.*y", r"mouth.*(open|form)"],
    "mouthForm": [r"param.*mouth.*form", r"mouth.*(smile|shape|form)"],
    "breath": [r"param.*breath", r"breath(ing)?"],
    "cheek": [r"param.*cheek", r"blush"],
}

ACTION_REQUIREMENTS = {
    "idle": ["headYaw", "headPitch"],
    "blink": ["eyeLeftOpen", "eyeRightOpen"],
    "talk": ["mouthOpen"],
    "nod": ["headPitch"],
    "shake": ["headYaw"],
    "happy": ["eyeLeftOpen", "eyeRightOpen", "mouthForm"],
    "thinking": ["headYaw", "headRoll", "eyeBallX"],
    "surprised": ["eyeLeftOpen", "eyeRightOpen", "mouthOpen", "browLeftY", "browRightY"],
    "shy": ["headPitch", "eyeLeftOpen", "eyeRightOpen", "cheek"],
}


def load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Cannot read JSON: {path}: {error}") from error


def resolve_model(target: Path) -> Path:
    if target.is_file() and target.name.endswith(".model3.json"):
        return target
    candidates = sorted(target.rglob("*.model3.json")) if target.is_dir() else []
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        raise ValueError("No .model3.json found. Pass a runtime folder or model3.json file.")
    listing = "\n  ".join(str(item) for item in candidates)
    raise ValueError(f"Multiple model3.json files found; pass one explicitly:\n  {listing}")


def curve_parameter_ids(runtime: Path) -> set[str]:
    ids: set[str] = set()
    for motion in runtime.rglob("*.motion3.json"):
        try:
            for curve in load_json(motion).get("Curves", []):
                if curve.get("Target") == "Parameter" and curve.get("Id"):
                    ids.add(curve["Id"])
        except ValueError:
            continue
    return ids


def parameter_ids(runtime: Path) -> set[str]:
    ids = curve_parameter_ids(runtime)
    for cdi in runtime.glob("*.cdi3.json"):
        try:
            ids.update(item["Id"] for item in load_json(cdi).get("Parameters", []) if item.get("Id"))
        except ValueError:
            continue
    return ids


def physics_outputs(runtime: Path) -> set[str]:
    outputs: set[str] = set()
    for physics in runtime.glob("*.physics3.json"):
        try:
            for setting in load_json(physics).get("PhysicsSettings", []):
                for output in setting.get("Output", []):
                    destination = output.get("Destination", {})
                    if destination.get("Id"):
                        outputs.add(destination["Id"])
        except ValueError:
            continue
    return outputs


def map_roles(ids: set[str], physics: set[str]) -> tuple[dict[str, str | None], dict[str, list[str]]]:
    mapping: dict[str, str | None] = {}
    warnings: dict[str, list[str]] = {}
    for role, patterns in ROLE_PATTERNS.items():
        # Patterns are intentionally ordered from precise to permissive.  A
        # mouth-form parameter must not win over ParamMouthOpenY merely because
        # its ID sorts first, otherwise audio lip-sync silently drives smiles.
        matches: list[str] = []
        for pattern in patterns:
            matches = [pid for pid in sorted(ids) if re.search(pattern, pid, re.I)]
            if matches:
                break
        direct = [pid for pid in matches if pid not in physics]
        mapping[role] = direct[0] if direct else None
        if matches and not direct:
            warnings[role] = matches
    return mapping, warnings


def action_result(mapping: dict[str, str | None]) -> dict[str, dict[str, object]]:
    result = {}
    for action, requirements in ACTION_REQUIREMENTS.items():
        missing = [role for role in requirements if not mapping.get(role)]
        result[action] = {"enabled": not missing, "missingRoles": missing}
    return result


def verdict(actions: dict[str, dict[str, object]]) -> tuple[str, list[str]]:
    enabled = {name for name, item in actions.items() if item["enabled"]}
    hard_required = {"idle", "blink", "talk"}
    if hard_required <= enabled:
        if {"nod", "shake", "happy"} <= enabled:
            return "ready", ["MVP conversation loop and expressive feedback are available."]
        return "degraded", ["Use the base conversation loop; hide actions that require unavailable parameters."]
    missing = sorted(hard_required - enabled)
    return "manual_review", [f"Cannot safely ship the base loop before resolving: {', '.join(missing)}."]


def preset(root: Path, name: str) -> dict:
    return load_json(root / "presets" / f"{name}.json")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", type=Path, help="Runtime directory or .model3.json")
    parser.add_argument("--preset", choices=["gentle", "lively", "calm"], default="gentle")
    parser.add_argument("--write-profile", type=Path, help="Write a reusable character.profile.json")
    args = parser.parse_args()

    try:
        model = resolve_model(args.target.resolve())
        runtime = model.parent
        mapping, physics_warnings = map_roles(parameter_ids(runtime), physics_outputs(runtime))
    except ValueError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2

    actions = action_result(mapping)
    status, notes = verdict(actions)
    profile = {
        "version": 1,
        "character": {"id": model.stem.replace(".model3", ""), "sourceModel": str(model)},
        "style": preset(Path(__file__).parent, args.preset),
        "motion": {"allowedActions": [name for name, item in actions.items() if item["enabled"]], "allowPhysics": True},
        "parameterMap": mapping,
    }
    report = {
        "status": status,
        "notes": notes,
        "profile": profile,
        "actions": actions,
        "doNotAnimateDirectly": sorted({pid for items in physics_warnings.values() for pid in items}),
        "physicsRoleWarnings": physics_warnings,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.write_profile:
        args.write_profile.parent.mkdir(parents=True, exist_ok=True)
        args.write_profile.write_text(json.dumps(profile, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"\nWrote profile: {args.write_profile}", file=sys.stderr)
    return 0 if status != "manual_review" else 1


if __name__ == "__main__":
    raise SystemExit(main())
