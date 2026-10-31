"""Redline backend: read Markdown/code files and persist annotation sidecars.

Mounted at /api/plugins/redline/ when the dashboard plugin is discovered.
Code files are lexed with Pygments (already in the gateway venv) into a flat
token list the desktop pane renders; any lexer failure degrades to plain text.

Extension sets, sidecar resolution and sidecar I/O live in ``redline_common`` (stdlib only).
``GET /doc`` and ``GET /annotations`` accept ``since_mtime`` (the ``mtimeNs`` of a previous
answer) and short-circuit to ``unchanged: true`` without reading or lexing anything.
"""
import importlib.util
import json
import os
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

try:  # Pygments ships in the gateway venv transitively (via rich/pytest); a
# minimal install may lack it — then code renders as plain text, never 500.
    from pygments import lex
    from pygments.lexers import TextLexer, get_lexer_for_filename
    from pygments.util import ClassNotFound
    _HAVE_PYGMENTS = True
except ImportError:
    _HAVE_PYGMENTS = False
    lex = TextLexer = get_lexer_for_filename = None
    ClassNotFound = Exception


def _load_common():
    """Load redline_common.py from the plugin root (this file lives in dashboard/)."""
    existing = sys.modules.get("redline_common")
    if existing is not None:
        return existing
    path = Path(__file__).resolve().parent.parent / "redline_common.py"
    spec = importlib.util.spec_from_file_location("redline_common", path)
    if spec is None or spec.loader is None:
        raise ImportError("redline_common.py not found beside the plugin")
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("redline_common", module)
    spec.loader.exec_module(module)
    return sys.modules["redline_common"]


common = _load_common()

router = APIRouter()

MAX_BYTES = 1_000_000
MAX_TOKENS = 200_000

# Pygments token dotted name -> redline CSS class; walk prefixes so
# Token.Keyword.Constant -> Keyword, Token.Name.Function -> Name.Function.
# Unmapped types render plain.
_TOKEN_CLASS = {
    "Keyword": "kw", "Name.Function": "fn", "Name.Class": "typ",
    "String": "str", "Comment": "com", "Number": "num",
    "Operator": "op", "Name.Decorator": "dec",
}


def _token_class(ttype) -> str:
    s = str(ttype)  # canonical dotted name, e.g. Token.Literal.String.Doc
    for key, cls in _TOKEN_CLASS.items():
        if ("." + key + ".") in s or s.endswith("." + key):
            return cls
    return ""


def _tokens(p: Path, content: str) -> list:
    if not _HAVE_PYGMENTS:
        return []
    try:
        lexer = get_lexer_for_filename(p.name, text=content, stripnl=False,
                                        ensurenl=False, encoding="utf-8")
    except (ClassNotFound, Exception):
        lexer = TextLexer(stripnl=False, ensurenl=False)
    out = []
    try:
        for ttype, value in lex(content, lexer):
            cls = _token_class(ttype)
            if out and out[-1][0] == cls:
                out[-1][1] += value
            else:
                out.append([cls, value])
            if len(out) > MAX_TOKENS:
                return []  # pathological file: pane falls back to plain content
    except Exception:
        return []
    return out


def _resolve(path: str) -> Path:
    # resolve() first: a symlink named .md must not smuggle a non-markdown target
    p = common.resolve_existing_file(os.path.expanduser(str(path).strip()))
    if p is None:  # also finds a file whose OpenSpec change was archived since it was recorded
        raise HTTPException(404, f"file not found: {path}")
    if p.suffix.lower() not in (common.MD_EXT + common.CODE_EXT):
        raise HTTPException(400, "redline reads Markdown and source files only")
    if not p.is_file():
        raise HTTPException(404, f"not a file: {p}")
    if p.stat().st_size > MAX_BYTES:
        raise HTTPException(413, "file too large for redline")
    return p


def _read_items(sc: Path) -> list:
    try:
        return common.read_sidecar_items(sc)
    except ValueError as exc:
        raise HTTPException(500, str(exc)) from exc


def _mtime_ns(path: Path) -> int:
    try:
        return path.stat().st_mtime_ns if path.is_file() else 0
    except OSError:
        return 0


def _mtime_unchanged(since_mtime: int | None, mtime_ns: int) -> bool:
    """True when ``since_mtime`` (the ``mtimeNs`` a client got earlier) still names ``mtime_ns``.

    ``st_mtime_ns`` needs 61 bits but a JavaScript client holds it as an IEEE-754 float64 (53-bit
    mantissa) and echoes back a rounded value (decimal-shortest, e.g. ...456800 for ...456789), so
    also accept a ``since_mtime`` that rounds to the same float64 as ``mtime_ns``, bounded to a
    1 ms distance so a real edit is never mistaken for float64 rounding noise.
    """
    if since_mtime is None:
        return False
    return since_mtime == mtime_ns or (
        mtime_ns > 0
        and since_mtime > 0
        and abs(since_mtime - mtime_ns) < 1_000_000
        and float(since_mtime) == float(mtime_ns)
    )


@router.get("/doc")
def read_doc(path: str = Query(...), since_mtime: int | None = Query(None)):
    p = _resolve(path)
    mtime_ns = p.stat().st_mtime_ns
    if _mtime_unchanged(since_mtime, mtime_ns):
        return {"path": str(p), "unchanged": True, "mtimeNs": mtime_ns}
    content = p.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n")
    tokens = _tokens(p, content) if p.suffix.lower() in common.CODE_EXT else []
    return {"path": str(p), "unchanged": False, "mtimeNs": mtime_ns, "content": content, "tokens": tokens}


@router.get("/annotations")
def get_annotations(path: str = Query(...), since_mtime: int | None = Query(None)):
    p = _resolve(path)
    sc, storage = common.resolve_sidecar_for_read(p)
    mtime_ns = _mtime_ns(sc)
    base = {"mtimeNs": mtime_ns, "sidecarPath": str(sc), "storage": storage}
    if _mtime_unchanged(since_mtime, mtime_ns):
        return {"unchanged": True, **base}
    return {"unchanged": False, **base, "items": _read_items(sc) if sc.is_file() else []}


@router.post("/annotations")
def save_annotations(body: dict):
    p = _resolve(str(body.get("path", "")))
    items = body.get("items")
    if not isinstance(items, list):
        raise HTTPException(400, "items must be a list")
    if len(items) > 200 or len(json.dumps(items)) > 512_000:
        raise HTTPException(413, "too many/too large annotations")
    sc, storage = common.resolve_sidecar(p)
    # ponytail: replace is atomic on one filesystem; add locking only if concurrent editors matter.
    session_id = str(body.get("sessionId") or body.get("session_id") or "").strip() or None
    common.write_sidecar_atomic(sc, items, target_file=p, storage=storage, session_id=session_id)
    return {"ok": True, "count": len(items), "sidecarPath": str(sc), "storage": storage, "mtimeNs": _mtime_ns(sc)}


@router.get("/recent")
def recent(limit: int = Query(12, ge=1, le=50), session_id: str | None = Query(None)):
    return {"items": common.list_recent_sidecars(common.resolve_hermes_home(), limit=limit, session_id=session_id)}
