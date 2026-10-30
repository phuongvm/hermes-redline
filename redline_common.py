"""Redline shared helpers: one owner for extensions, fenced-code stripping, skip rules and sidecars.

Stdlib only — no fastapi and no Hermes runtime imports — so the agent hooks (``__init__.py``),
the dashboard routes (``dashboard/plugin_api.py``) and the tests can all load it standalone.
``desktop/plugin.js`` mirrors ``MD_EXT`` / ``CODE_EXT`` and ``scripts/selfcheck.py`` enforces
the parity, so this file is the single Python-side definition.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

MD_EXT = (".md", ".markdown")
CODE_EXT = (
    ".py", ".sh", ".ps1", ".psm1", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
    ".html", ".svg", ".css", ".scss", ".c", ".h", ".cpp", ".go", ".rs", ".rb",
    ".yaml", ".yml", ".json", ".toml", ".xml", ".ini", ".cfg", ".sql",
)

SIDECAR_MODES = ("auto", "central", "adjacent")
SIDECAR_SUFFIX = ".redline.json"
MODE_ENV = "REDLINE_SIDECAR_MODE"

# Shared documentation files that never get an automatic review card (matched by lower-cased basename).
_SKIP_BASENAMES = frozenset({"readme.md", "skill.md", "agents.md", "changelog.md"})
_SKIP_PARTS = frozenset({"skills", ".git", "node_modules", "__pycache__", ".pytest_cache"})
_AGENT_SHARE = ("openspec", "workspace", "sessions", "agent_share.md")

_FENCE_OPEN = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})")


# --------------------------------------------------------------------------- fenced code

def strip_fenced_code(text: str) -> str:
    """Return ``text`` with fenced code blocks (``` or ~~~, opener and closer included) removed.

    A fence closes on a line holding only the same character, at least as many times as the opener.
    An unclosed fence runs to the end of the text, as in CommonMark.
    """
    out: list[str] = []
    fence: tuple[str, int] | None = None
    for line in str(text or "").splitlines(keepends=True):
        if fence is None:
            m = _FENCE_OPEN.match(line)
            if m:
                marker = m.group(1)
                # A backtick fence cannot carry a backtick in its info string.
                if marker[0] == "`" and "`" in line[m.end():]:
                    out.append(line)
                    continue
                fence = (marker[0], len(marker))
                continue
            out.append(line)
            continue
        stripped = line.strip()
        if stripped and set(stripped) == {fence[0]} and len(stripped) >= fence[1]:
            fence = None
    return "".join(out)


# --------------------------------------------------------------------------- skip rules

def has_reviewable_ext(path: str | Path) -> bool:
    ext = Path(str(path)).suffix.lower()
    return ext in MD_EXT or ext in CODE_EXT


def skip_auto_card_path(path: str | Path) -> bool:
    """True when a written file must not get an automatic ::redline card.

    ``.worktrees/`` paths stay eligible. This is the single owner of the documentation-basename
    exclusion (README / SKILL / AGENTS / CHANGELOG, any case, any depth).
    """
    parts = tuple(p.lower() for p in PurePosixPath(str(path).replace("\\", "/")).parts)
    if not parts:
        return True
    if any(parts[i:i + 2] == (".hermes", "cache") for i in range(len(parts) - 1)):
        return True
    if any(p in _SKIP_PARTS for p in parts):
        return True
    if parts[-1].endswith(SIDECAR_SUFFIX):
        return True
    if parts[-1] in _SKIP_BASENAMES:
        return True
    n = len(_AGENT_SHARE)
    return len(parts) >= n and parts[-n:] == _AGENT_SHARE


# --------------------------------------------------------------------------- hermes home + mode

def resolve_hermes_home(hermes_home: str | Path | None = None, env=None) -> Path:
    """explicit arg -> ``HERMES_HOME`` -> ``hermes_constants.get_hermes_home()`` -> ``~/.hermes``."""
    if hermes_home:
        return Path(hermes_home).expanduser()
    source = os.environ if env is None else env
    configured = source.get("HERMES_HOME")
    if configured:
        return Path(configured).expanduser()
    if env is None:
        try:
            from hermes_constants import get_hermes_home  # type: ignore

            return Path(get_hermes_home())
        except Exception:
            pass
    return Path.home() / ".hermes"


def _config_sidecar_mode(config_path: Path) -> str | None:
    """``plugins.entries.redline.settings.sidecar_mode`` from config.yaml, or None."""
    try:
        text = config_path.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        import yaml  # type: ignore

        data = yaml.safe_load(text) or {}
        node = data
        for key in ("plugins", "entries", "redline", "settings"):
            node = node.get(key) if isinstance(node, dict) else None
        value = node.get("sidecar_mode") if isinstance(node, dict) else None
        return str(value).strip().lower() if value is not None else None
    except ImportError:
        pass
    except Exception:
        return None
    # Indentation walk for installs without PyYAML: plugins > entries > redline > settings > sidecar_mode.
    wanted = ["plugins", "entries", "redline", "settings"]
    stack: list[tuple[int, str]] = []
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        key, _, value = raw.strip().partition(":")
        while stack and stack[-1][0] >= indent:
            stack.pop()
        if [k for _, k in stack] == wanted and key == "sidecar_mode":
            return value.strip().strip("'\"").lower() or None
        stack.append((indent, key.strip()))
    return None


def resolve_sidecar_mode(mode: str | None = None, *, hermes_home=None, env=None) -> str:
    """explicit ``mode`` -> ``REDLINE_SIDECAR_MODE`` -> config.yaml setting -> ``auto``."""
    source = os.environ if env is None else env
    candidates = [mode, source.get(MODE_ENV)]
    for candidate in candidates:
        value = str(candidate or "").strip().lower()
        if value in SIDECAR_MODES:
            return value
    configured = _config_sidecar_mode(resolve_hermes_home(hermes_home, env) / "config.yaml")
    return configured if configured in SIDECAR_MODES else "auto"


# --------------------------------------------------------------------------- sidecar paths

def find_enclosing_git_root(file_path: Path) -> Path | None:
    """Nearest parent holding ``.git`` — a directory, or the gitdir file of a worktree/submodule."""
    try:
        start = Path(file_path).resolve()
    except OSError:
        return None
    for parent in start.parents:
        if (parent / ".git").exists():
            return parent
    return None


def adjacent_sidecar_path(resolved_file: Path) -> Path:
    return resolved_file.parent / (resolved_file.name + SIDECAR_SUFFIX)


def central_sidecar_path(resolved_file: Path, hermes_home: Path) -> Path:
    key = os.path.normcase(str(resolved_file)).replace("\\", "/")
    sha16 = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", resolved_file.name)[:80]
    return Path(hermes_home) / "redline" / "annotations" / f"{sha16}-{safe}{SIDECAR_SUFFIX}"


def resolve_sidecar(resolved_file: Path, *, mode: str | None = None, hermes_home=None, env=None) -> tuple[Path, str]:
    """Where annotations for ``resolved_file`` are WRITTEN, with the storage kind."""
    resolved_file = Path(resolved_file)
    home = resolve_hermes_home(hermes_home, env)
    effective = resolve_sidecar_mode(mode, hermes_home=home, env=env)
    adj = adjacent_sidecar_path(resolved_file)
    if effective == "adjacent":
        return adj, "adjacent"
    cen = central_sidecar_path(resolved_file, home)
    if effective == "central":
        return cen, "central"
    if adj.is_file():
        return adj, "adjacent"
    if cen.is_file() or find_enclosing_git_root(resolved_file) is not None:
        return cen, "central"
    return adj, "adjacent"


def resolve_sidecar_for_read(resolved_file: Path, *, mode: str | None = None, hermes_home=None, env=None) -> tuple[Path, str]:
    """Where annotations are READ: like ``resolve_sidecar`` but ``central`` falls back to an existing adjacent file."""
    sc, storage = resolve_sidecar(resolved_file, mode=mode, hermes_home=hermes_home, env=env)
    if storage == "central" and not sc.is_file():
        adj = adjacent_sidecar_path(Path(resolved_file))
        if adj.is_file():
            return adj, "adjacent"
    return sc, storage


# --------------------------------------------------------------------------- sidecar io

def _parse_sidecar(sc: Path) -> tuple[list, bool]:
    """(items, is_envelope). ValueError on unreadable JSON or an unexpected shape."""
    try:
        data = json.loads(sc.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"sidecar is not valid JSON: {sc}") from exc
    if isinstance(data, list):
        return data, False
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        return data["items"], True
    raise ValueError(f"sidecar must contain a JSON list or an items envelope: {sc}")


def read_sidecar_items(sc: Path) -> list:
    return _parse_sidecar(Path(sc))[0]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def write_sidecar_atomic(sc: Path, items: list, *, target_file: Path, storage: str) -> None:
    """Replace ``sc`` atomically. Central sidecars (and existing envelopes) are enveloped; others stay bare lists."""
    sc = Path(sc)
    envelope = storage == "central"
    if not envelope and sc.is_file():
        try:
            envelope = _parse_sidecar(sc)[1]
        except ValueError:
            envelope = False
    payload = (
        {"file": str(target_file), "updatedAt": _utc_now(), "items": items} if envelope else items
    )
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    sc.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix=f".{sc.name}.", suffix=".tmp", dir=sc.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(temp_path, sc)
    except BaseException:
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass
        raise


def list_recent_sidecars(hermes_home, *, limit: int = 12) -> list[dict]:
    """Newest centralized sidecars whose target file still exists, with per-status counts."""
    root = Path(hermes_home) / "redline" / "annotations"
    try:
        entries = [(p.stat().st_mtime_ns, p) for p in root.glob("*" + SIDECAR_SUFFIX) if p.is_file()]
    except OSError:
        return []
    out: list[dict] = []
    for mtime_ns, sc in sorted(entries, key=lambda e: e[0], reverse=True):
        try:
            data = json.loads(sc.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        if not (isinstance(data, dict) and isinstance(data.get("items"), list) and data.get("file")):
            continue
        target = Path(str(data["file"]))
        if not target.is_file():
            continue
        items = [a for a in data["items"] if isinstance(a, dict)]
        count = lambda status: sum(1 for a in items if a.get("status") == status and not a.get("draft"))  # noqa: E731
        out.append({
            "path": str(target),
            "sidecarPath": str(sc),
            "openCount": count("open"),
            "sentCount": count("sent"),
            "resolvedCount": count("resolved"),
            "updatedAt": str(data.get("updatedAt") or datetime.fromtimestamp(mtime_ns / 1e9, timezone.utc).isoformat(timespec="seconds")),
        })
        if len(out) >= limit:
            break
    return out
