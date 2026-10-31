"""Backend tests: redline_common, the agent hooks and the dashboard routes.

Everything runs against temp directories; nothing touches a real Hermes home.
"""
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def common():
    return _load("redline_common", ROOT / "redline_common.py")


@pytest.fixture()
def hooks(common, monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hooks_hermes_home"))
    module = _load("redline_hooks_under_test", ROOT / "__init__.py")
    module._written.clear()
    return module


@pytest.fixture()
def api(common, monkeypatch, tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    module = _load("redline_api_under_test", ROOT / "dashboard" / "plugin_api.py")
    home = tmp_path / "hermes_home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("REDLINE_SIDECAR_MODE", raising=False)
    app = FastAPI()
    app.include_router(module.router)
    client = TestClient(app)
    client.module = module
    client.home = home
    return client


BIG_MD = "# Title\n\n" + ("A reviewable paragraph that is long enough to pass the size floor. " * 4) + "\n"


def _md(path: Path, body: str = BIG_MD) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return path


# ------------------------------------------------------------------ redline_common

def test_common_imports_without_fastapi_or_hermes():
    code = (
        "import sys, importlib.util;"
        "sys.modules['fastapi']=None; sys.modules['hermes_constants']=None;"
        f"s=importlib.util.spec_from_file_location('rc', r'{ROOT / 'redline_common.py'}');"
        "m=importlib.util.module_from_spec(s); s.loader.exec_module(m);"
        "assert '.ps1' in m.CODE_EXT and m.MD_EXT==('.md','.markdown');"
        "print(m.strip_fenced_code('a\\n```\\nb\\n```\\nc\\n'))"
    )
    out = subprocess.run([sys.executable, "-B", "-c", code], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    assert "b" not in out.stdout.split() and "a" in out.stdout and "c" in out.stdout


def test_common_extension_sets_include_expanded_types(common):
    for ext in (".ps1", ".psm1", ".mjs", ".cjs", ".jsx", ".html", ".svg", ".css", ".scss", ".xml", ".ini", ".cfg"):
        assert ext in common.CODE_EXT
    assert ".exe" not in common.CODE_EXT and ".png" not in common.CODE_EXT


@pytest.mark.parametrize("text,expected_present,expected_absent", [
    ("keep\n```text\n::redline{x}\n```\ntail\n", ["keep", "tail"], ["::redline"]),
    ("keep\n~~~\n::redline{x}\n~~~\ntail\n", ["keep", "tail"], ["::redline"]),
    ("a\n````\n```\n::redline{x}\n```\n````\nz\n", ["a", "z"], ["::redline"]),  # longer fence swallows a shorter one
    ("a\n```\nnever closed ::redline{x}\n", ["a"], ["::redline"]),
    ("top ::redline{file=\"/x.md\"}\n", ["::redline"], []),
])
def test_common_strip_fenced_code(common, text, expected_present, expected_absent):
    out = common.strip_fenced_code(text)
    for piece in expected_present:
        assert piece in out
    for piece in expected_absent:
        assert piece not in out


@pytest.mark.parametrize("path", [
    "README.md", "readme.md", "SKILL.md", "AGENTS.md", "CHANGELOG.md",
    "docs/ReadMe.MD", "a/b/c/AGENTS.md", r"C:\proj\sub\README.md", "O:/ws/.worktrees/wt/CHANGELOG.md",
])
def test_common_skip_auto_card_path_skips_documentation_basenames(common, path):
    assert common.skip_auto_card_path(path) is True


@pytest.mark.parametrize("path", [
    "proposal.md", "design.md", "docs/readme-notes.md", "docs/my-readme.md",
    "O:/workspaces/.worktrees/wt-x/openspec/changes/c/proposal.md", r"C:\a\.worktrees\w\tasks.md",
    "src/run.ps1",
])
def test_common_skip_auto_card_path_keeps_lookalikes_and_worktrees(common, path):
    assert common.skip_auto_card_path(path) is False


@pytest.mark.parametrize("path", [
    r"C:\Users\x\.hermes\cache\y.py", "/p/skills/a.md", "/p/.git/x.md", "/p/node_modules/a.js",
    "/p/a.md.redline.json", "/w/openspec/workspace/sessions/agent_share.md",
])
def test_common_skip_auto_card_path_skips_infrastructure(common, path):
    assert common.skip_auto_card_path(path) is True


@pytest.mark.parametrize("path", [
    r"C:\Users\x\AppData\Local\hermes\cache\scratch\probe.py", "/h/cache/scratch/notes.md",
    "O:/workspaces/_config/hermes/profiles/coder/cache/scratch/a.md",
])
def test_common_skip_auto_card_path_skips_cache_scratch(common, path):
    assert common.skip_auto_card_path(path) is True


def test_common_skip_auto_card_path_keeps_scratch_outside_cache(common):
    assert common.skip_auto_card_path("/w/scratch/notes.md") is False
    assert common.skip_auto_card_path("/w/cache/notes.md") is False


def test_common_resolve_hermes_home_precedence(common, tmp_path):
    assert common.resolve_hermes_home(tmp_path / "x", env={"HERMES_HOME": "/other"}) == tmp_path / "x"
    assert common.resolve_hermes_home(None, env={"HERMES_HOME": str(tmp_path / "e")}) == tmp_path / "e"
    assert common.resolve_hermes_home(None, env={}) == Path.home() / ".hermes"


def test_common_sidecar_mode_precedence(common, tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    assert common.resolve_sidecar_mode(None, hermes_home=home, env={}) == "auto"
    (home / "config.yaml").write_text(
        "plugins:\n  entries:\n    redline:\n      settings:\n        sidecar_mode: adjacent\n", encoding="utf-8")
    assert common.resolve_sidecar_mode(None, hermes_home=home, env={}) == "adjacent"
    assert common.resolve_sidecar_mode(None, hermes_home=home, env={"REDLINE_SIDECAR_MODE": "central"}) == "central"
    assert common.resolve_sidecar_mode("auto", hermes_home=home, env={"REDLINE_SIDECAR_MODE": "central"}) == "auto"
    assert common.resolve_sidecar_mode(None, hermes_home=home, env={"REDLINE_SIDECAR_MODE": "bogus"}) == "adjacent"


def test_common_sidecar_ladder_auto_mode(common, tmp_path):
    home = tmp_path / "home"
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    plan = _md(repo / "docs" / "plan.md")
    legacy = _md(repo / "docs" / "legacy.md")
    (repo / "docs" / "legacy.md.redline.json").write_text("[]", encoding="utf-8")
    outside = _md(tmp_path / "scratch" / "outside.md")

    sc, storage = common.resolve_sidecar(plan, mode="auto", hermes_home=home, env={})
    assert storage == "central" and sc.parent == home / "redline" / "annotations"
    assert sc.name.endswith("-plan.md.redline.json")
    sc, storage = common.resolve_sidecar(legacy, mode="auto", hermes_home=home, env={})
    assert storage == "adjacent" and sc == repo / "docs" / "legacy.md.redline.json"
    sc, storage = common.resolve_sidecar(outside, mode="auto", hermes_home=home, env={})
    assert storage == "adjacent" and sc == outside.parent / "outside.md.redline.json"


def test_common_sidecar_git_worktree_gitfile_counts_as_repo(common, tmp_path):
    repo = tmp_path / "wt"
    repo.mkdir()
    (repo / ".git").write_text("gitdir: /elsewhere\n", encoding="utf-8")
    f = _md(repo / "a.md")
    assert common.find_enclosing_git_root(f) == repo.resolve()
    assert common.resolve_sidecar(f, mode="auto", hermes_home=tmp_path / "h", env={})[1] == "central"


def test_common_sidecar_io_envelope_and_bare_list(common, tmp_path):
    target = _md(tmp_path / "a.md")
    central = tmp_path / "h" / "redline" / "annotations" / "x.redline.json"
    common.write_sidecar_atomic(central, [{"id": "1"}], target_file=target, storage="central")
    data = json.loads(central.read_text(encoding="utf-8"))
    assert data["file"] == str(target) and data["items"] == [{"id": "1"}] and data["updatedAt"]
    assert common.read_sidecar_items(central) == [{"id": "1"}]

    bare = tmp_path / "a.md.redline.json"
    common.write_sidecar_atomic(bare, [{"id": "2"}], target_file=target, storage="adjacent")
    assert json.loads(bare.read_text(encoding="utf-8")) == [{"id": "2"}]
    # An adjacent file that is already an envelope stays an envelope.
    bare.write_text(json.dumps({"file": str(target), "items": []}), encoding="utf-8")
    common.write_sidecar_atomic(bare, [{"id": "3"}], target_file=target, storage="adjacent")
    assert json.loads(bare.read_text(encoding="utf-8"))["items"] == [{"id": "3"}]
    assert not list(tmp_path.glob(".*.tmp"))


def test_common_list_recent_sidecars_orders_and_counts(common, tmp_path):
    home = tmp_path / "h"
    a, b, gone = _md(tmp_path / "a.md"), _md(tmp_path / "b.md"), tmp_path / "gone.md"
    for name, target, items in (("a", a, [{"status": "open"}, {"status": "sent"}]),
                                ("b", b, [{"status": "resolved"}]),
                                ("c", gone, [{"status": "open"}])):
        sc = common.central_sidecar_path(Path(target), home)
        common.write_sidecar_atomic(sc, items, target_file=target, storage="central")
        os.utime(sc, ns=(1_000_000_000 * (10 + "abc".index(name)),) * 2)
    rows = common.list_recent_sidecars(home, limit=5)
    assert [Path(r["path"]).name for r in rows] == ["b.md", "a.md"]  # newest first, vanished target dropped
    assert rows[1]["openCount"] == 1 and rows[1]["sentCount"] == 1 and rows[0]["resolvedCount"] == 1
    assert len(common.list_recent_sidecars(home, limit=1)) == 1


# ------------------------------------------------------------------ hooks

def _turn(hooks, session, *paths, tool="write_file"):
    for p in paths:
        hooks._post_tool_call(tool, {"path": str(p)}, "ok", session_id=session)


def test_hooks_multi_file_bundle_in_write_order_without_duplicates(hooks, tmp_path):
    root = tmp_path / ".worktrees" / "wt" / "openspec"
    prop, design, tasks = _md(root / "proposal.md"), _md(root / "design.md"), _md(root / "tasks.md")
    share = _md(root / "workspace" / "sessions" / "agent_share.md")
    readme = _md(root / "README.md")
    _turn(hooks, "s1", prop, design, share, prop, tasks, readme)
    _turn(hooks, "s1", prop, tool="patch")
    out = hooks._transform_llm_output("done", session_id="s1", platform="desktop")
    expected = ", ".join([f"file={json.dumps(str(prop.resolve()))}",
                          f"file_1={json.dumps(str(design.resolve()))}",
                          f"file_2={json.dumps(str(tasks.resolve()))}"])
    assert out == f"done\n\n::redline{{{expected}}}"
    assert "s1" not in hooks._written


def test_hooks_single_file_keeps_plain_file_attr(hooks, tmp_path):
    f = _md(tmp_path / "plan.md")
    _turn(hooks, "s", f)
    out = hooks._transform_llm_output("ok", session_id="s", platform="desktop")
    assert out.endswith(f"::redline{{file={json.dumps(str(f.resolve()))}}}")


def test_hooks_bundle_is_capped_at_eight_files(hooks, tmp_path):
    files = [_md(tmp_path / f"f{i}.md") for i in range(11)]
    _turn(hooks, "s", *files)
    out = hooks._transform_llm_output("ok", session_id="s", platform="desktop")
    assert out.count("file") == 8 and "file_7=" in out and "file_8=" not in out


def test_hooks_non_ascii_path_is_not_escaped(hooks, tmp_path):
    f = _md(tmp_path / "kế-hoạch.md")
    _turn(hooks, "s", f)
    out = hooks._transform_llm_output("ok", session_id="s", platform="desktop")
    assert "kế-hoạch.md" in out and "\\u" not in out


def test_hooks_literal_directive_inside_fence_does_not_suppress_card(hooks, tmp_path):
    f = _md(tmp_path / "a.md")
    for fence in ("```", "~~~"):
        _turn(hooks, "s", f)
        text = f"Example:\n{fence}text\n::redline{{file=\"/example.md\"}}\n{fence}\nbye"
        out = hooks._transform_llm_output(text, session_id="s", platform="desktop")
        assert out is not None and out.rstrip().endswith("}") and out.count("::redline{") == 2


def test_hooks_top_level_directive_or_non_desktop_suppresses_card(hooks, tmp_path):
    f = _md(tmp_path / "a.md")
    _turn(hooks, "s", f)
    assert hooks._transform_llm_output('x\n::redline{file="/a.md"}', session_id="s", platform="desktop") is None
    assert "s" not in hooks._written  # consumed either way
    _turn(hooks, "s", f)
    assert hooks._transform_llm_output("x", session_id="s", platform="cli") is None
    hooks._on_session_end(session_id="s")
    assert "s" not in hooks._written


def test_hooks_documentation_only_turn_emits_no_directive(hooks, tmp_path):
    docs = [_md(tmp_path / n) for n in ("README.md", "SKILL.md", "AGENTS.md", "CHANGELOG.md")]
    _turn(hooks, "s", *docs)
    assert hooks._written.get("s") is None
    assert hooks._transform_llm_output("done", session_id="s", platform="desktop") is None


def test_hooks_have_no_duplicate_inline_skip_set():
    src = (ROOT / "__init__.py").read_text(encoding="utf-8")
    assert '"readme.md"' not in src.lower() and "'readme.md'" not in src.lower()
    assert "_MD_EXT" not in src and "_CODE_EXT" not in src


def test_hooks_drop_files_deleted_before_the_turn_ends(hooks, tmp_path):
    keep, gone = _md(tmp_path / "keep.md"), _md(tmp_path / "gone.md")
    _turn(hooks, "s", gone, keep)
    gone.unlink()
    out = hooks._transform_llm_output("ok", session_id="s", platform="desktop")
    assert f"file={json.dumps(str(keep.resolve()))}" in out and "gone.md" not in out


# ------------------------------------------------------------------ dashboard routes

def test_api_expanded_filetypes_accepted_and_binary_rejected(api, tmp_path):
    for name in ("run.ps1", "page.html", "logo.svg", "mod.mjs", "data.xml"):
        p = tmp_path / name
        p.write_text("line one\nline two\r\nline three\n", encoding="utf-8")
        r = api.get("/doc", params={"path": str(p)})
        assert r.status_code == 200, (name, r.text)
        assert "\r" not in r.json()["content"] and isinstance(r.json()["tokens"], list)
    for name in ("tool.exe", "pic.png"):
        p = tmp_path / name
        p.write_bytes(b"MZ\x00")
        assert api.get("/doc", params={"path": str(p)}).status_code == 400


def test_api_doc_since_mtime_short_circuits_without_lexing(api, tmp_path, monkeypatch):
    p = tmp_path / "s.py"
    p.write_text("x = 1\n", encoding="utf-8")
    first = api.get("/doc", params={"path": str(p)}).json()
    assert first["unchanged"] is False and first["tokens"]

    calls = []
    original = api.module._tokens
    monkeypatch.setattr(api.module, "_tokens", lambda *a, **k: calls.append(1) or original(*a, **k))
    same = api.get("/doc", params={"path": str(p), "since_mtime": first["mtimeNs"]}).json()
    assert same == {"path": first["path"], "unchanged": True, "mtimeNs": first["mtimeNs"]}
    assert calls == []

    p.write_text("x = 2\ny = 3\n", encoding="utf-8")
    os.utime(p, ns=(first["mtimeNs"] + 5_000_000_000,) * 2)
    changed = api.get("/doc", params={"path": str(p), "since_mtime": first["mtimeNs"]}).json()
    assert changed["unchanged"] is False and "y = 3" in changed["content"] and changed["mtimeNs"] > first["mtimeNs"]
    assert calls == [1]


def _js_roundtrip(ns: int) -> int:
    """What a JS client sends back for ``ns``: ``String(Number(ns))`` is the shortest decimal of the float64."""
    from decimal import Decimal
    return int(Decimal(repr(float(ns))))


def test_api_doc_since_mtime_survives_ieee754_float64_rounding(api, tmp_path):
    p = tmp_path / "f.md"
    p.write_text("# T\n", encoding="utf-8")
    ns = 1_793_456_789_123_456_700  # 61-bit (100 ns steps on NTFS): a JS Number cannot hold it exactly
    os.utime(p, ns=(ns, ns))
    first = api.get("/doc", params={"path": str(p)}).json()
    assert first["mtimeNs"] == ns and _js_roundtrip(ns) != ns  # JSON.parse then String() gives ...800
    rounded = api.get("/doc", params={"path": str(p), "since_mtime": _js_roundtrip(ns)}).json()
    assert rounded == {"path": first["path"], "unchanged": True, "mtimeNs": ns}
    # a real edit well beyond float64 resolution is still reported
    os.utime(p, ns=(ns + 5_000_000_000,) * 2)
    assert api.get("/doc", params={"path": str(p), "since_mtime": _js_roundtrip(ns)}).json()["unchanged"] is False
    assert api.get("/doc", params={"path": str(p), "since_mtime": 0}).json()["unchanged"] is False


def test_api_annotations_since_mtime_survives_ieee754_float64_rounding(api, tmp_path):
    plan = _md(tmp_path / "repo" / "plan.md")
    sc = Path(api.post("/annotations", json={"path": str(plan), "items": []}).json()["sidecarPath"])
    ns = 1_793_456_789_123_456_700
    os.utime(sc, ns=(ns, ns))
    rounded = api.get("/annotations", params={"path": str(plan), "since_mtime": _js_roundtrip(ns)}).json()
    assert rounded["unchanged"] is True and rounded["mtimeNs"] == ns


def test_api_annotations_central_mode_keeps_repo_clean_and_short_circuits(api, tmp_path):
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    plan = _md(repo / "docs" / "plan.md")
    item = [{"id": "a1", "kind": "comment", "block": 0, "quote": "Title", "note": "n", "status": "open"}]

    empty = api.get("/annotations", params={"path": str(plan)}).json()
    assert empty["items"] == [] and empty["storage"] == "central" and empty["mtimeNs"] == 0
    assert api.get("/annotations", params={"path": str(plan), "since_mtime": 0}).json()["unchanged"] is True

    saved = api.post("/annotations", json={"path": str(plan), "items": item}).json()
    assert saved["ok"] is True and saved["count"] == 1 and saved["storage"] == "central" and saved["mtimeNs"] > 0
    assert Path(saved["sidecarPath"]).parent == api.home / "redline" / "annotations"
    assert list(repo.rglob("*.redline.json")) == []

    got = api.get("/annotations", params={"path": str(plan)}).json()
    assert got["items"] == item and got["sidecarPath"] == saved["sidecarPath"]
    unchanged = api.get("/annotations", params={"path": str(plan), "since_mtime": got["mtimeNs"]}).json()
    assert unchanged == {"unchanged": True, "mtimeNs": got["mtimeNs"], "sidecarPath": got["sidecarPath"], "storage": "central"}


def test_api_legacy_adjacent_sidecar_updates_in_place_and_outside_repo_is_adjacent(api, tmp_path):
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    legacy = _md(repo / "legacy.md")
    side = repo / "legacy.md.redline.json"
    side.write_text("[]", encoding="utf-8")
    api.post("/annotations", json={"path": str(legacy), "items": [{"id": "z", "status": "open"}]})
    assert json.loads(side.read_text(encoding="utf-8")) == [{"id": "z", "status": "open"}]  # bare list preserved
    assert not (api.home / "redline").exists()

    outside = _md(tmp_path / "scratch" / "outside.md")
    r = api.post("/annotations", json={"path": str(outside), "items": []}).json()
    assert r["storage"] == "adjacent" and Path(r["sidecarPath"]) == outside.parent / "outside.md.redline.json"


def test_api_explicit_modes_and_env_override(api, tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    repo.mkdir()
    a = _md(repo / "a.md")
    (api.home / "config.yaml").write_text(
        "plugins:\n  entries:\n    redline:\n      settings:\n        sidecar_mode: adjacent\n", encoding="utf-8")
    r = api.post("/annotations", json={"path": str(a), "items": [{"id": "1"}]}).json()
    assert r["storage"] == "adjacent" and (repo / "a.md.redline.json").is_file()

    monkeypatch.setenv("REDLINE_SIDECAR_MODE", "central")
    got = api.get("/annotations", params={"path": str(a)}).json()
    assert got["storage"] == "adjacent" and got["items"] == [{"id": "1"}]  # central fallback reads the adjacent file
    r2 = api.post("/annotations", json={"path": str(a), "items": [{"id": "2"}]}).json()
    assert r2["storage"] == "central" and Path(r2["sidecarPath"]).parent == api.home / "redline" / "annotations"
    assert json.loads((repo / "a.md.redline.json").read_text(encoding="utf-8")) == [{"id": "1"}]


def test_api_recent_lists_centralized_sidecars(api, tmp_path, monkeypatch):
    monkeypatch.setenv("REDLINE_SIDECAR_MODE", "central")
    files = [_md(tmp_path / f"d{i}.md") for i in range(3)]
    for i, f in enumerate(files):
        r = api.post("/annotations", json={"path": str(f), "items": [{"id": "x", "status": "open"}]}).json()
        os.utime(r["sidecarPath"], ns=(1_000_000_000 * (100 + i),) * 2)
    rows = api.get("/recent", params={"limit": 2}).json()["items"]
    assert [Path(r["path"]).name for r in rows] == ["d2.md", "d1.md"]
    assert rows[0]["openCount"] == 1 and rows[0]["sidecarPath"] and rows[0]["updatedAt"]
    assert api.get("/recent", params={"limit": 0}).status_code == 422


def test_api_validation_limits_and_bad_sidecar(api, tmp_path):
    a = _md(tmp_path / "a.md")
    assert api.post("/annotations", json={"path": str(a), "items": "no"}).status_code == 400
    assert api.post("/annotations", json={"path": str(a), "items": [{}] * 201}).status_code == 413
    (tmp_path / "a.md.redline.json").write_text("{not json", encoding="utf-8")
    assert api.get("/annotations", params={"path": str(a)}).status_code == 500
    assert api.get("/doc", params={"path": str(tmp_path / "missing.md")}).status_code == 404


# ------------------------------------------------------------------ session-scoped documents

def _central(common, home, target, items, session_id=None):
    sc = common.central_sidecar_path(Path(target), home)
    common.write_sidecar_atomic(sc, items, target_file=target, storage="central", session_id=session_id)
    return sc


def test_session_manifest_path_is_stable_and_filesystem_safe(common, tmp_path):
    p = common.session_manifest_path("sess/A:1", tmp_path)
    assert p.parent == tmp_path / "redline" / "sessions" and p.name.endswith("-sess_A_1.json")
    assert p == common.session_manifest_path("sess/A:1", tmp_path)
    assert p != common.session_manifest_path("sess_A_1", tmp_path)  # sha16 keeps lookalikes apart


def test_record_session_files_keeps_reviewable_existing_files_in_front_order(common, tmp_path):
    home = tmp_path / "h"
    a, b, c = _md(tmp_path / "a.md"), _md(tmp_path / "b.md"), _md(tmp_path / "c.py", "x = 1\n" * 20)
    junk = tmp_path / "pic.png"
    junk.write_bytes(b"\x89PNG")
    readme = _md(tmp_path / "README.md")
    assert common.record_session_files("s1", [a, b, junk, readme, tmp_path / "gone.md"], hermes_home=home) == [
        str(a), str(b)]
    merged = common.record_session_files("s1", [c, b], hermes_home=home)
    assert merged == [str(c), str(b), str(a)]  # new files lead, no duplicates
    manifest = json.loads(common.session_manifest_path("s1", home).read_text(encoding="utf-8"))
    assert manifest["sessionId"] == "s1" and manifest["files"] == merged and manifest["updatedAt"]


def test_record_session_files_collapses_escaped_separators_into_one_entry(common, tmp_path):
    home = tmp_path / "h"
    a = _md(tmp_path / "docs" / "a.md")
    escaped = str(a).replace("\\", "\\\\")  # JSON-escaped directive attribute: every \ doubled
    forward = str(a).replace("\\", "/")
    out = common.record_session_files("s1", [escaped, forward, a], hermes_home=home)
    assert len(out) == 1 and os.path.normcase(os.path.normpath(out[0])) == os.path.normcase(os.path.normpath(str(a)))
    # a manifest written earlier with several spellings of one path folds on the next record
    manifest = common.session_manifest_path("s1", home)
    manifest.write_text(json.dumps({"sessionId": "s1", "files": [escaped, str(a), forward]}), encoding="utf-8")
    b = _md(tmp_path / "docs" / "b.md")
    merged = common.record_session_files("s1", [b], hermes_home=home)
    keys = [os.path.normcase(os.path.normpath(f)) for f in merged]
    assert keys == [os.path.normcase(os.path.normpath(str(b))), os.path.normcase(os.path.normpath(str(a)))]


@pytest.mark.parametrize("sid", ["", "   ", "_", None])
def test_record_session_files_ignores_unbound_sessions(common, tmp_path, sid):
    f = _md(tmp_path / "a.md")
    assert common.record_session_files(sid, [f], hermes_home=tmp_path / "h") == []
    assert not (tmp_path / "h" / "redline" / "sessions").exists()


def test_record_session_files_caps_manifest_at_32(common, tmp_path):
    files = [_md(tmp_path / f"f{i}.md") for i in range(40)]
    out = common.record_session_files("s", files, hermes_home=tmp_path / "h")
    assert len(out) == 32 and out[0] == str(files[0])


def test_read_session_files_reports_documents_before_any_annotation(common, tmp_path):
    home = tmp_path / "h"
    a, b = _md(tmp_path / "a.md"), _md(tmp_path / "b.md")
    common.record_session_files("sA", [a, b], hermes_home=home)
    rows = common.read_session_files("sA", hermes_home=home)
    assert [Path(r["path"]).name for r in rows] == ["a.md", "b.md"]
    assert all(r["sessionId"] == "sA" and r["openCount"] == 0 and r["sentCount"] == 0 and r["resolvedCount"] == 0
               for r in rows)
    _central(common, home, a, [{"status": "open"}, {"status": "resolved"}])
    first = common.read_session_files("sA", hermes_home=home)[0]
    assert first["openCount"] == 1 and first["resolvedCount"] == 1 and first["sidecarPath"]
    b.unlink()
    assert [Path(r["path"]).name for r in common.read_session_files("sA", hermes_home=home)] == ["a.md"]
    assert common.read_session_files("other", hermes_home=home) == []


def test_write_sidecar_atomic_tags_sessions_without_changing_format(common, tmp_path):
    home = tmp_path / "h"
    target = _md(tmp_path / "a.md")
    sc = _central(common, home, target, [{"id": "1"}], session_id="sA")
    data = json.loads(sc.read_text(encoding="utf-8"))
    assert data["sessions"] == ["sA"] and data["items"] == [{"id": "1"}]
    assert sc.read_text(encoding="utf-8") == json.dumps(data, ensure_ascii=False, indent=2)  # REDLINE-INV-2
    _central(common, home, target, [{"id": "2"}], session_id="sB")
    _central(common, home, target, [{"id": "3"}], session_id="sA")
    _central(common, home, target, [{"id": "4"}])  # a save with no session keeps the owners
    assert json.loads(sc.read_text(encoding="utf-8"))["sessions"] == ["sA", "sB"]
    assert [Path(r["path"]).name for r in common.read_session_files("sA", hermes_home=home)] == ["a.md"]
    bare = tmp_path / "x.md.redline.json"
    common.write_sidecar_atomic(bare, [{"id": "9"}], target_file=target, storage="adjacent", session_id="sA")
    assert json.loads(bare.read_text(encoding="utf-8")) == [{"id": "9"}]  # bare lists stay bare


def test_list_recent_sidecars_session_filter_isolates_sessions(common, tmp_path):
    home = tmp_path / "h"
    legacy, a, b, ghost = (_md(tmp_path / n) for n in ("legacy.md", "a.md", "b.md", "ghost.md"))
    _central(common, home, legacy, [{"status": "open"}])  # unscoped
    _central(common, home, a, [{"status": "open"}], session_id="sA")
    _central(common, home, b, [{"status": "sent"}], session_id="sB")
    common.record_session_files("sA", [ghost], hermes_home=home)  # recorded, never annotated

    assert {Path(r["path"]).name for r in common.list_recent_sidecars(home, limit=10)} == {"legacy.md", "a.md", "b.md"}
    rows = common.list_recent_sidecars(home, limit=10, session_id="sA")
    assert sorted(Path(r["path"]).name for r in rows) == ["a.md", "ghost.md"]
    assert all(r["sessionId"] == "sA" for r in rows)
    assert [r["openCount"] for r in rows if r["path"].endswith("a.md")] == [1]
    assert [Path(r["path"]).name for r in common.list_recent_sidecars(home, session_id="sB")] == ["b.md"]
    for blank in ("", "  ", "_", "nobody"):
        assert common.list_recent_sidecars(home, session_id=blank) == []
    assert len(common.list_recent_sidecars(home, limit=1, session_id="sA")) == 1


def test_hooks_record_written_files_per_session(hooks, common, tmp_path, monkeypatch):
    home = tmp_path / "h"
    monkeypatch.setenv("HERMES_HOME", str(home))
    a, b = _md(tmp_path / "a.md"), _md(tmp_path / "b.md")
    readme = _md(tmp_path / "README.md")
    _turn(hooks, "sA", a, readme)
    _turn(hooks, "sB", b)
    _turn(hooks, "", b)  # unbound turn records nothing
    assert [Path(r["path"]).name for r in common.read_session_files("sA", hermes_home=home)] == ["a.md"]
    assert [Path(r["path"]).name for r in common.read_session_files("sB", hermes_home=home)] == ["b.md"]


def test_hooks_transform_records_bundle_and_top_level_directive_files(hooks, common, tmp_path, monkeypatch):
    home = tmp_path / "h"
    monkeypatch.setenv("HERMES_HOME", str(home))
    a, b, c = (_md(tmp_path / n) for n in ("a.md", "b.md", "c.md"))
    _turn(hooks, "sA", a, b)
    hooks._transform_llm_output("done", session_id="sA", platform="desktop")
    assert [Path(r["path"]).name for r in common.read_session_files("sA", hermes_home=home)] == ["a.md", "b.md"]

    text = f'see ::redline{{file={json.dumps(str(c))}, file_1={json.dumps(str(a))}}}\n```\n::redline{{file="{b}"}}\n```'
    assert hooks._transform_llm_output(text, session_id="sA", platform="desktop") is None
    assert [Path(r["path"]).name for r in common.read_session_files("sA", hermes_home=home)] == ["c.md", "a.md", "b.md"]
    assert common.read_session_files("sB", hermes_home=home) == []


# ------------------------------------------------------------------ dashboard routes: session scope

def test_api_post_annotations_tags_session_and_recent_filters_by_it(api, tmp_path, monkeypatch):
    monkeypatch.setenv("REDLINE_SIDECAR_MODE", "central")
    a, b, legacy = (_md(tmp_path / n) for n in ("a.md", "b.md", "legacy.md"))
    item = [{"id": "x", "status": "open"}]
    api.post("/annotations", json={"path": str(a), "items": item, "sessionId": "sA"})
    api.post("/annotations", json={"path": str(b), "items": item, "session_id": "sB"})
    api.post("/annotations", json={"path": str(legacy), "items": item})

    assert len(api.get("/recent").json()["items"]) == 3  # no session_id: legacy behavior
    rows = api.get("/recent", params={"session_id": "sA"}).json()["items"]
    assert [Path(r["path"]).name for r in rows] == ["a.md"] and rows[0]["sessionId"] == "sA"
    assert [Path(r["path"]).name for r in api.get("/recent", params={"session_id": "sB"}).json()["items"]] == ["b.md"]
    assert api.get("/recent", params={"session_id": ""}).json()["items"] == []
    assert api.get("/recent", params={"session_id": "session-empty"}).json()["items"] == []
