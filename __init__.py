"""Redline agent-side hooks: make the ::redline{...} card automatic.

post_tool_call  — remember Markdown/source files this agent turn wrote (write_file/patch), up to 8.
transform_llm_output — if the final response delivered reviewable files and the agent did not emit
a top-level ::redline directive itself, append one (desktop only): ``file`` plus ``file_1..N``.

Observer/transform only; no core overrides. Fail-soft by design: any error here
must never affect the response.
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path


def _load_common():
    """Load redline_common.py beside this file; the plugin package name is synthetic, so go by path."""
    existing = sys.modules.get("redline_common")
    if existing is not None:
        return existing
    spec = importlib.util.spec_from_file_location("redline_common", Path(__file__).resolve().parent / "redline_common.py")
    if spec is None or spec.loader is None:
        raise ImportError("redline_common.py not found beside the plugin")
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("redline_common", module)
    spec.loader.exec_module(module)
    return sys.modules["redline_common"]


_common = _load_common()
strip_fenced_code = _common.strip_fenced_code
skip_auto_card_path = _common.skip_auto_card_path
MD_EXT = _common.MD_EXT
CODE_EXT = _common.CODE_EXT

_DIRECTIVE_RE = re.compile(r"::redline\{")
_DIRECTIVE_FILE_RE = re.compile(r'\bfile(?:_\d+)?\s*=\s*"([^"\n]*)"')
# ponytail: path heuristics instead of a config knob; add config_schema if users want opt-out granularity.
_MIN_BYTES = 200
MAX_BUNDLE_FILES = 8

_written: dict[str, list[str]] = {}


def _eligible(path: str) -> bool:
    try:
        p = Path(path).expanduser()
    except Exception:
        return False
    ext = p.suffix.lower()
    if ext not in MD_EXT and ext not in CODE_EXT:
        return False
    if skip_auto_card_path(path):
        return False
    try:
        if not p.is_file() or p.stat().st_size < (_MIN_BYTES if ext in MD_EXT else 40):
            return False
    except OSError:
        return False
    return True


def _directive_files(text: str) -> list[str]:
    """Quoted ``file`` / ``file_N`` values of the ::redline directives in ``text``."""
    return [m.group(1) for m in _DIRECTIVE_FILE_RE.finditer(text)]


def _post_tool_call(tool_name: str, args: dict, result, session_id: str = "", **kwargs):
    try:
        # post_tool_call dispatch (model_tools.py) carries no platform kwarg; gating it here
        # would disable tracking even on desktop. The leak gate is in _transform_llm_output,
        # which does receive platform (turn_finalizer.py). State is bounded + cleared on session end.
        if tool_name not in {"write_file", "patch"}:
            return
        path = (args or {}).get("path") or ""
        if not path or not _eligible(path):
            return
        resolved = str(Path(path).expanduser().resolve())
        bucket = _written.setdefault(session_id or "_", [])
        if resolved not in bucket and len(bucket) < MAX_BUNDLE_FILES:
            bucket.append(resolved)
        _common.record_session_files(session_id, [resolved])
    except Exception:
        pass  # observers must never break a turn


def _transform_llm_output(response_text: str, session_id: str = "", **kwargs):
    try:
        if kwargs.get("platform") != "desktop":
            return None
        paths = _written.pop(session_id or "_", None)
        if not response_text:
            return None
        # A literal directive quoted inside a fenced block is documentation, not a card.
        top_level = strip_fenced_code(response_text)
        if _DIRECTIVE_RE.search(top_level):
            _common.record_session_files(session_id, _directive_files(top_level))
            return None
        if not paths:
            return None
        paths = [p for p in paths if Path(p).is_file()]
        if not paths:
            return None
        _common.record_session_files(session_id, paths)  # bundle order leads the session manifest
        # ensure_ascii=False: the desktop directive parser reads attribute values
        # verbatim (no JSON unescape), so \uXXXX escapes would reach the redline
        # backend as literal text and 404 on any non-ASCII path.
        attrs = [f"file={json.dumps(paths[0], ensure_ascii=False)}"]
        attrs += [f"file_{i}={json.dumps(p, ensure_ascii=False)}" for i, p in enumerate(paths[1:], 1)]
        return response_text + f"\n\n::redline{{{', '.join(attrs)}}}"
    except Exception:
        return None  # fail-soft: never touch the response on error


def _on_session_end(session_id: str = "", **kwargs):
    try:
        _written.pop(session_id or "_", None)
    except Exception:
        pass  # observers must never break a turn


def register(ctx):
    ctx.register_hook("post_tool_call", _post_tool_call)
    ctx.register_hook("transform_llm_output", _transform_llm_output)
    ctx.register_hook("on_session_end", _on_session_end)
    skill_md = Path(__file__).resolve().parent / "SKILL.md"
    if skill_md.is_file():
        ctx.register_skill(
            "reading", skill_md,
            description="Use when a redline batch arrives from the desktop panel, or after delivering a Markdown document or source file the user will review.",
        )
