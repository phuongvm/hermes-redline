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
    if any(parts[i:i + 2] in ((".hermes", "cache"), ("cache", "scratch")) for i in range(len(parts) - 1)):
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


# --------------------------------------------------------------------------- archived OpenSpec files

def _archive_candidates(path: Path) -> list[Path]:
    """Where ``.../changes/<id>/<rest>`` lives once its change is archived: ``changes/archive/<id>/<rest>``,
    or ``changes/archive/<date>-<id>/<rest>`` (newest first). ``[]`` for a path outside a live change."""
    parts = path.parts
    at = next((i for i in range(len(parts) - 3, -1, -1) if parts[i].lower() == "changes"), -1)
    if at < 0 or at + 2 >= len(parts) or parts[at + 1].lower() == "archive":
        return []
    change_id, rest = parts[at + 1], Path(*parts[at + 2:])
    archive = Path(*parts[:at + 1]) / "archive"
    out = [archive / change_id / rest]
    try:
        dated = sorted((d for d in archive.glob("*-" + change_id) if d.is_dir()), key=lambda d: d.name, reverse=True)
    except OSError:
        dated = []
    return out + [d / rest for d in dated]


def _pre_archive_paths(path: Path) -> list[Path]:
    """The live ``changes/<id>/<rest>`` location of an archived ``changes/archive/[<date>-]<id>/<rest>`` file."""
    parts = path.parts
    at = next((i for i in range(len(parts) - 3, -1, -1)
               if parts[i].lower() == "changes" and parts[i + 1].lower() == "archive"), -1)
    if at < 0:
        return []
    folder = parts[at + 2]
    ids = [folder]
    dated = re.match(r"\d{4}-\d{2}-\d{2}-(.+)$", folder)
    if dated:
        ids.append(dated.group(1))
    base = Path(*parts[:at + 1])
    return [base / change_id / Path(*parts[at + 3:]) for change_id in ids]


def resolve_existing_file(path) -> Path | None:
    """The existing file ``path`` names: the path itself first, else its archived OpenSpec location.

    ``None`` when neither exists. A change that was archived after a session recorded its files keeps
    resolving, so the document still opens.
    """
    text = str(path or "").strip()
    if not text:
        return None
    candidate = Path(re.sub(r"\\{2,}", lambda _m: "\\", text)).expanduser()
    try:
        if candidate.is_file():
            return candidate.resolve()
        for alt in _archive_candidates(candidate):
            if alt.is_file():
                return alt.resolve()
    except (OSError, RuntimeError):
        return None
    return None


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
        # The change was archived after the notes were written: they still sit under the pre-archive path.
        home = resolve_hermes_home(hermes_home, env)
        for earlier in _pre_archive_paths(Path(resolved_file)):
            old = central_sidecar_path(earlier, home)
            if old.is_file():
                return old, "central"
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


def write_sidecar_atomic(sc: Path, items: list, *, target_file: Path, storage: str, session_id: str | None = None) -> None:
    """Replace ``sc`` atomically. Central sidecars (and existing envelopes) are enveloped; others stay bare lists.

    An envelope records the sessions that saved annotations on it (``"sessions"``): existing owners are kept
    and ``session_id`` is appended, so a later save with no session never drops the owners.
    """
    sc = Path(sc)
    envelope = storage == "central"
    existing: dict = {}
    if sc.is_file():
        try:
            existing_data = json.loads(sc.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            existing_data = None
        if isinstance(existing_data, dict) and isinstance(existing_data.get("items"), list):
            existing = existing_data
            envelope = True
    sid = _clean_session_id(session_id)
    if envelope:
        payload = {"file": str(target_file), "updatedAt": _utc_now(), "items": items}
        sessions = [s for s in existing.get("sessions", []) if isinstance(s, str)]
        if sid and sid not in sessions:
            sessions.append(sid)
        if sessions:
            payload["sessions"] = sessions
    else:
        payload = items
    _write_text_atomic(sc, json.dumps(payload, ensure_ascii=False, indent=2))
    if envelope and sid and storage == "central":
        record_session_files(sid, [target_file], hermes_home=sc.parent.parent.parent)


# --------------------------------------------------------------------------- session manifests

MAX_SESSION_FILES = 32


def _clean_session_id(session_id) -> str:
    """The usable session id, or ``""`` for blank / the ``_`` placeholder of an unbound turn."""
    sid = str(session_id or "").strip()
    return "" if sid == "_" else sid


def session_manifest_path(session_id: str, hermes_home) -> Path:
    key = str(session_id)
    sha16 = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", key)[:80]
    return Path(hermes_home) / "redline" / "sessions" / f"{sha16}-{safe}.json"


def _write_text_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(temp_path, path)
    except BaseException:
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass
        raise


def _path_key(path) -> str:
    return os.path.normcase(os.path.normpath(str(path)))


def _dedupe_paths(paths) -> list[str]:
    """``paths`` in order, keeping the first spelling of each path (separator style and case folded)."""
    seen: set[str] = set()
    out: list[str] = []
    for path in paths:
        key = _path_key(path)
        if key not in seen:
            seen.add(key)
            out.append(path)
    return out


def _read_manifest_files(manifest: Path) -> list[str]:
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return []
    files = data.get("files") if isinstance(data, dict) else None
    return [f for f in files if isinstance(f, str)] if isinstance(files, list) else []


def record_session_files(session_id, files, *, hermes_home=None, env=None) -> list[str]:
    """Remember reviewable ``files`` for ``session_id``: newest first, de-duplicated, capped at 32.

    Blank / ``_`` sessions, missing files, non-reviewable extensions and auto-card exclusions are ignored.
    Returns the full manifest, or ``[]`` when the session is unbound.
    """
    sid = _clean_session_id(session_id)
    if not sid:
        return []
    fresh: list[str] = []
    for raw in files or []:
        try:
            # A JSON-escaped directive attribute doubles every backslash: collapse before resolving.
            p = Path(re.sub(r"\\{2,}", lambda _m: "\\", str(raw))).expanduser().resolve()
        except (OSError, RuntimeError):
            continue
        text = str(p)
        if _path_key(text) not in {_path_key(f) for f in fresh} and p.is_file() and has_reviewable_ext(p) and not skip_auto_card_path(p):
            fresh.append(text)
    manifest = session_manifest_path(sid, resolve_hermes_home(hermes_home, env))
    previous = _read_manifest_files(manifest)
    if not fresh:
        return previous
    merged = _dedupe_paths(fresh + previous)[:MAX_SESSION_FILES]
    payload = {"sessionId": sid, "updatedAt": _utc_now(), "files": merged}
    _write_text_atomic(manifest, json.dumps(payload, ensure_ascii=False, indent=2))
    return merged


def _status_counts(items: list) -> dict:
    live = [a for a in items if isinstance(a, dict) and not a.get("draft")]
    count = lambda status: sum(1 for a in live if a.get("status") == status)  # noqa: E731
    return {"openCount": count("open"), "sentCount": count("sent"), "resolvedCount": count("resolved")}


def read_session_files(session_id, *, hermes_home=None, env=None) -> list[dict]:
    """The session's recorded files that still exist, with live annotation counts (zero before any annotation)."""
    sid = _clean_session_id(session_id)
    if not sid:
        return []
    home = resolve_hermes_home(hermes_home, env)
    manifest = session_manifest_path(sid, home)
    recorded = _read_manifest_files(manifest)
    rows: list[dict] = []
    healed: list[str] = []
    for name in recorded:
        direct = Path(name)
        target = direct if direct.is_file() else resolve_existing_file(name)
        if target is None:
            healed.append(name)  # keep the entry: a temporarily unavailable file is not forgotten
            continue
        healed.append(name if direct.is_file() else str(target))
        if any(_path_key(r["path"]) == _path_key(target) for r in rows):
            continue  # a pre-archive and a post-archive spelling of one file
        sc, _storage = resolve_sidecar_for_read(target, hermes_home=home, env=env)
        items: list = []
        updated_ns = 0
        if sc.is_file():
            try:
                items = read_sidecar_items(sc)
                updated_ns = sc.stat().st_mtime_ns
            except (ValueError, OSError):
                items = []
        if not updated_ns:
            try:
                updated_ns = target.stat().st_mtime_ns
            except OSError:
                updated_ns = 0
        rows.append({
            "path": str(target),
            "sidecarPath": str(sc) if sc.is_file() else "",
            **_status_counts(items),
            "updatedAt": datetime.fromtimestamp(updated_ns / 1e9, timezone.utc).isoformat(timespec="seconds"),
            "sessionId": sid,
        })
    healed = _dedupe_paths(healed)
    if healed != recorded:
        _persist_healed_manifest(manifest, sid, healed)
    return rows


def _persist_healed_manifest(manifest: Path, sid: str, files: list[str]) -> None:
    """Rewrite a session manifest whose entries moved (archived); a read-only home just keeps the old one."""
    try:
        payload = {"sessionId": sid, "updatedAt": _utc_now(), "files": files}
        _write_text_atomic(manifest, json.dumps(payload, ensure_ascii=False, indent=2))
    except OSError:
        pass


def list_recent_sidecars(hermes_home, *, limit: int = 12, session_id: str | None = None) -> list[dict]:
    """Newest centralized sidecars whose target file still exists, with per-status counts.

    ``session_id=None`` is the unfiltered legacy listing. A supplied ``session_id`` returns only that
    session's documents (its recorded files first, then sidecars it annotated), each stamped with
    ``sessionId``; a blank or ``_`` id, and a session with nothing, return ``[]``.
    """
    scoped = session_id is not None
    sid = _clean_session_id(session_id) if scoped else ""
    if scoped and not sid:
        return []
    out: list[dict] = read_session_files(sid, hermes_home=hermes_home)[:limit] if scoped else []
    seen = {os.path.normcase(r["path"]) for r in out}
    if len(out) >= limit:
        return out
    root = Path(hermes_home) / "redline" / "annotations"
    try:
        entries = [(p.stat().st_mtime_ns, p) for p in root.glob("*" + SIDECAR_SUFFIX) if p.is_file()]
    except OSError:
        return out
    for mtime_ns, sc in sorted(entries, key=lambda e: e[0], reverse=True):
        try:
            data = json.loads(sc.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        if not (isinstance(data, dict) and isinstance(data.get("items"), list) and data.get("file")):
            continue
        if scoped and sid not in (data.get("sessions") or []):
            continue
        target = Path(str(data["file"]))
        if not target.is_file() or (scoped and os.path.normcase(str(target)) in seen):
            continue
        seen.add(os.path.normcase(str(target)))
        row = {
            "path": str(target),
            "sidecarPath": str(sc),
            **_status_counts(data["items"]),
            "updatedAt": str(data.get("updatedAt") or datetime.fromtimestamp(mtime_ns / 1e9, timezone.utc).isoformat(timespec="seconds")),
        }
        if scoped:
            row["sessionId"] = sid
        out.append(row)
        if len(out) >= limit:
            break
    return out
