#!/usr/bin/env python3
"""Cross-surface extension parity and Windows-path regression check.

redline_common.py owns MD_EXT / CODE_EXT; desktop/plugin.js must mirror them exactly (same
order), and neither __init__.py nor dashboard/plugin_api.py may define its own extension literals.
"""
import ast
import importlib.util
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXT_NAMES = {"MD_EXT", "CODE_EXT", "_MD_EXT", "_CODE_EXT"}


def assigned_tuple(path: Path, name: str) -> tuple[str, ...]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return tuple(ast.literal_eval(node.value))
    raise AssertionError(f"{name} missing from {path}")


def js_extensions(name: str) -> tuple[str, ...]:
    js = (
        "const fs=require('fs');const s=fs.readFileSync(process.argv[1],'utf8');"
        "const m=s.match(new RegExp('const '+process.argv[2]+' = (\\\\[[\\\\s\\\\S]*?\\\\])'));"
        "if(!m)throw Error(process.argv[2]+' missing');"
        "console.log(JSON.stringify(Function('return '+m[1])()));"
    )
    out = subprocess.check_output(["node", "-e", js, str(ROOT / "desktop/plugin.js"), name], text=True)
    return tuple(json.loads(out))


def defines_extension_literals(path: Path) -> list[str]:
    """Module-level names that (re)define an extension set instead of importing it from redline_common."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found = []
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in EXT_NAMES and isinstance(node.value, (ast.Tuple, ast.List, ast.Set)):
                    found.append(target.id)
    return found


def main() -> None:
    common_path = ROOT / "redline_common.py"
    md = assigned_tuple(common_path, "MD_EXT")
    code = assigned_tuple(common_path, "CODE_EXT")
    assert js_extensions("MD_EXT") == md, (js_extensions("MD_EXT"), md)
    assert js_extensions("CODE_EXT") == code, (js_extensions("CODE_EXT"), code)
    for rel in ("__init__.py", "dashboard/plugin_api.py"):
        dupes = defines_extension_literals(ROOT / rel)
        assert not dupes, f"{rel} must not define extension literals: {dupes}"

    spec = importlib.util.spec_from_file_location("redline_common_selfcheck", common_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.MD_EXT == md and module.CODE_EXT == code
    assert module.skip_auto_card_path(r"C:\Users\x\.hermes\cache\y.py")
    assert not module.skip_auto_card_path("/home/x/note.py")
    print("redline selfcheck: ok")


if __name__ == "__main__":
    main()
