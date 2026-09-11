#!/usr/bin/env python3
"""Stage, guide, and verify a native Cubism MOC3 export.

Cubism Editor owns the actual MOC3 compiler.  This script deliberately does
not rewrite a CMO3 or fabricate an MOC3: it creates an isolated handoff copy,
opens it in Cubism, watches the chosen export directory, then validates the
native package that Cubism wrote.

Typical use:
  python3 scripts/cubism-native-export.py \
    outputs/ana-golden-baseline-20260910/pro-browser-run/ana-golden-pro-wave-20260910.cmo3 \
    --output-dir outputs/ana-golden-baseline-20260910/native-cubism-export --watch

While it is watching, in Cubism:
  1. Verify ParamActionWave and the two elbow parameters.
  2. Ctrl+T → create/edit Texture Atlas → Perform Auto Layout → OK.
  3. Ctrl+Alt+S → export MOC3 → choose the output directory printed below.

The keyboard shortcuts are documented by Cubism; on macOS installations whose
shortcut mapping uses Command instead of Control, use the visible File/Modeling
menus instead.  Export confirmation remains intentionally in the editor so a
human sees Cubism's warnings before a production artifact is written.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
# Production exports use the stable Editor release.  The 5.4 alpha build is
# useful for its external-app bridge, but has texture-atlas regressions and is
# never the default compiler for deliverables.
DEFAULT_EDITOR = Path("/Applications/Live2D Cubism 5.3/Live2D Cubism Editor 5.3.app")
EXPECTED_PARAMETERS = (
    "ParamActionWave",
    "ParamRotation_leftElbow",
    "ParamRotation_rightElbow",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def die(message: str) -> None:
    raise SystemExit(f"导出未开始：{message}")


def json_write(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def require_cmo3(path: Path) -> None:
    if not path.is_file():
        die(f"找不到 CMO3：{path}")
    if path.suffix.lower() != ".cmo3":
        die("输入必须是 .cmo3。")
    if path.read_bytes()[:4] != b"CAFF":
        die("输入不是 Cubism CMO3 容器（缺少 CAFF 文件头）。")


def stage(source: Path, output_dir: Path) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    staged = output_dir / f"{source.stem}.source.cmo3"
    handoff = output_dir / "cubism-export-handoff.json"
    if staged.exists():
        die(f"已有同名工作副本，拒绝覆盖：{staged}")
    shutil.copy2(source, staged)
    json_write(handoff, {
        "createdAt": utc_now(),
        "source": str(source.resolve()),
        "stagedCmo3": str(staged.resolve()),
        "expectedParameters": list(EXPECTED_PARAMETERS),
        "requiredHumanChecks": [
            "在 Cubism 参数面板确认 ParamActionWave、ParamRotation_leftElbow、ParamRotation_rightElbow。",
            "纹理集使用 Perform Auto Layout，并在导出前检查没有未放置的 ArtMesh。",
            "导出设置保留 .moc3、.model3.json 与纹理；如有 physics3.json/cdi3.json 也一并勾选。",
        ],
        "exportDirectory": str(output_dir.resolve()),
        "scope": "Cubism Editor is the only MOC3 compiler in this handoff. This script validates output structure only.",
    })
    return staged, handoff


def open_in_cubism(editor: Path, staged: Path) -> None:
    if not editor.is_dir():
        die(f"找不到 Cubism Editor：{editor}")
    subprocess.run(["open", "-a", str(editor), str(staged)], check=True)


def latest_native_package(output_dir: Path, staged: Path | None) -> tuple[Path, Path] | None:
    moc_files = [path for path in output_dir.rglob("*.moc3") if path != staged]
    if not moc_files:
        return None
    moc = max(moc_files, key=lambda path: path.stat().st_mtime)
    model_candidates = list(moc.parent.glob("*.model3.json"))
    if not model_candidates:
        return None
    model = max(model_candidates, key=lambda path: path.stat().st_mtime)
    return moc, model


def check_model_references(model_path: Path) -> tuple[list[str], dict[str, Any]]:
    model = json.loads(model_path.read_text())
    refs = model.get("FileReferences")
    if not isinstance(refs, dict):
        return ["model3.json 缺少 FileReferences。"], model
    problems: list[str] = []
    moc_ref = refs.get("Moc")
    if not isinstance(moc_ref, str) or not (model_path.parent / moc_ref).is_file():
        problems.append("model3.json 的 Moc 引用不存在。")
    textures = refs.get("Textures", [])
    if not isinstance(textures, list) or not textures:
        problems.append("model3.json 没有纹理引用。")
    else:
        missing = [item for item in textures if not isinstance(item, str) or not (model_path.parent / item).is_file()]
        if missing:
            problems.append(f"缺少 {len(missing)} 个纹理引用。")
    return problems, model


def referenced_files(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [path for item in value for path in referenced_files(item)]
    if isinstance(value, dict):
        return [path for item in value.values() for path in referenced_files(item)]
    return []


def package_runtime(moc: Path, model: Path, cdi: Path | None, physics: Path | None, model_json: dict[str, Any]) -> Path:
    """Create a portable, model-scoped ZIP without sweeping unrelated Downloads files."""
    members = {moc, model}
    if cdi:
        members.add(cdi)
    if physics:
        members.add(physics)
    for reference in referenced_files(model_json.get("FileReferences", {})):
        candidate = (model.parent / reference).resolve()
        if candidate.is_file() and (candidate.parent == model.parent or model.parent in candidate.parents):
            members.add(candidate)
    archive = model.parent / f"{moc.stem}-native-runtime.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zipped:
        for member in sorted(members):
            zipped.write(member, member.relative_to(model.parent))
    return archive


def verify(output_dir: Path, staged: Path | None, handoff: Path | None) -> int:
    package = latest_native_package(output_dir, staged)
    if not package:
        print("尚未发现完整原生导出包（需要 .moc3 和 .model3.json）。")
        return 2
    moc, model = package
    problems: list[str] = []
    if moc.read_bytes()[:4] != b"MOC3":
        problems.append("MOC3 文件头无效；这不是 Cubism 的原生运行时文件。")
    model_problems, model_json = check_model_references(model)
    problems.extend(model_problems)
    # Downloads often contains exports from multiple characters.  Companion
    # files must match this exact MOC stem; taking the newest cdi3 would make
    # a valid export look as if it had lost another model's parameters.
    cdi = moc.with_suffix(".cdi3.json")
    physics = moc.with_suffix(".physics3.json")
    if not cdi.is_file():
        cdi = None
    if not physics.is_file():
        physics = None
    runtime_package = package_runtime(moc, model, cdi, physics, model_json)
    exported_parameter_ids: list[str] = []
    if cdi:
        try:
            cdi_data = json.loads(cdi.read_text())
            exported_parameter_ids = [
                item["Id"] for item in cdi_data.get("Parameters", [])
                if isinstance(item, dict) and isinstance(item.get("Id"), str)
            ]
            missing_parameters = [parameter for parameter in EXPECTED_PARAMETERS if parameter not in exported_parameter_ids]
            if missing_parameters:
                problems.append("运行时包缺少关键参数：" + "、".join(missing_parameters))
        except (OSError, json.JSONDecodeError):
            problems.append("无法读取 cdi3.json 参数清单。")
    else:
        problems.append("缺少 cdi3.json，无法验收运行时参数 ID。")
    report = {
        "verifiedAt": utc_now(),
        "handoff": str(handoff.resolve()) if handoff else None,
        "moc3": str(moc.resolve()),
        "model3": str(model.resolve()),
        "cdi3": str(cdi.resolve()) if cdi else None,
        "physics3": str(physics.resolve()) if physics else None,
        "textureCount": len(model_json.get("FileReferences", {}).get("Textures", [])),
        "runtimePackage": str(runtime_package.resolve()),
        "exportedParameterIds": exported_parameter_ids,
        "status": "passed" if not problems else "failed",
        "problems": problems,
        "manualParameterCheck": list(EXPECTED_PARAMETERS),
        "scope": "Verified native binary header and model3 file references. Parameter values and deformation quality must be confirmed in the open Cubism model before export.",
    }
    report_path = output_dir / "native-export-qa.json"
    json_write(report_path, report)
    print(f"原生导出质检报告：{report_path}")
    if problems:
        print("导出不通过：" + "；".join(problems))
        return 1
    print("原生 MOC3 包结构通过：MOC3 文件头、model3.json 与纹理引用均有效。")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Stage and validate a Cubism-native MOC3 export without touching the source CMO3.")
    parser.add_argument("source", type=Path, help="要导出的 CMO3 工程")
    parser.add_argument("--output-dir", type=Path, help="Cubism 导出目录；默认位于 CMO3 同级 native-cubism-export")
    parser.add_argument("--editor", type=Path, default=DEFAULT_EDITOR, help="Cubism Editor .app 路径")
    parser.add_argument("--watch", action="store_true", help="打开 Cubism 后监听导出目录，直到发现并检验 MOC3 包")
    parser.add_argument("--timeout", type=int, default=900, help="--watch 最长等待秒数，默认 900")
    parser.add_argument("--verify-only", action="store_true", help="不创建副本、不打开 Cubism，只检验已有导出包")
    args = parser.parse_args()

    source = args.source.expanduser().resolve()
    output_dir = (args.output_dir or source.parent / "native-cubism-export").expanduser().resolve()
    staged = output_dir / f"{source.stem}.source.cmo3"
    handoff = output_dir / "cubism-export-handoff.json"

    if args.verify_only:
        # At this point Cubism has already compiled the binary, so accepting
        # either the original CMO3 handoff or the native MOC3 is useful and
        # avoids making a verification-only command pretend it is a compiler.
        if not source.is_file() or source.suffix.lower() not in {".cmo3", ".moc3"}:
            die("--verify-only 的输入必须是已有的 .cmo3 或 .moc3。")
        return verify(
            output_dir,
            staged if staged.exists() else None,
            handoff if handoff.exists() else None,
        )

    require_cmo3(source)
    staged, handoff = stage(source, output_dir)
    print("已创建不覆盖原文件的 Cubism 工作副本：", staged)
    print("Cubism 导出目录：", output_dir)
    print("请在 Cubism 依次完成：参数检查 → Ctrl+T 纹理集自动布局 → Ctrl+Alt+S 导出 MOC3。")
    open_in_cubism(args.editor, staged)
    if not args.watch:
        print("完成导出后运行同一命令并加 --verify-only，即可生成结构质检报告。")
        return 0

    deadline = time.monotonic() + args.timeout
    print(f"正在监听原生导出，最长 {args.timeout} 秒…")
    while time.monotonic() < deadline:
        if latest_native_package(output_dir, staged):
            return verify(output_dir, staged, handoff)
        time.sleep(2)
    print("等待超时：未发现完整导出包。CMO3 工作副本与交接清单保留在导出目录中。")
    return 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as error:
        raise SystemExit(f"无法启动 Cubism：{error}")
