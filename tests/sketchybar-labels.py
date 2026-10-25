#!/usr/bin/env python3
"""Display-label persistence and interaction boundaries, never the live desktop."""

import sys
import importlib
import json
import subprocess
import signal
from unittest.mock import patch
from pathlib import Path
import tempfile
import unittest

PLUGINS = Path(__file__).resolve().parents[1] / "home/.config/sketchybar/plugins"
sys.path.insert(0, str(PLUGINS))
labels = importlib.import_module("workspace_labels")
w = importlib.import_module("workspaces")


def properties(args):
    result = {}
    for i, arg in enumerate(args):
        if arg == "--set":
            end = next(
                (j for j in range(i + 2, len(args)) if args[j].startswith("--")),
                len(args),
            )
            result.setdefault(args[i + 1], []).extend(args[i + 2 : end])
    return result


class LabelStoreTests(unittest.TestCase):
    def test_display_label_survives_new_store_without_changing_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            store = labels.Store(Path(temp).resolve() / "state")
            initial = store.read()
            self.assertEqual(initial, {"version": 1, "revision": 0, "labels": {}})
            store.update("os-finances", "  Финансы notes  ", {"1", "os-finances"}, 0)
            saved = labels.Store(Path(temp).resolve() / "state").read()
            self.assertEqual(saved["labels"], {"os-finances": "Финансы notes"})
            self.assertEqual(saved["revision"], 1)
            self.assertEqual(store.root.stat().st_mode & 0o777, 0o700)
            self.assertEqual(
                (store.root / "workspace-labels.json").stat().st_mode & 0o777, 0o600
            )
            store.update("os-finances", None, {"1", "os-finances"}, 1)
            self.assertEqual(store.read()["labels"], {})

    def test_corruption_symlink_and_failed_atomic_replace_preserve_original(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve() / "state"
            store = labels.Store(root)
            store.update("1", "Mail", {"1", "2"}, 0)
            path = root / "workspace-labels.json"
            original = path.read_bytes()
            with patch.object(
                labels.os, "replace", side_effect=OSError("disk failure")
            ):
                with self.assertRaises(OSError):
                    store.update("1", "Inbox", {"1", "2"}, 1)
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(list(root.glob(".labels-*")), [])
            for invalid in (
                b"{",
                b"[]",
                b"x" * 65537,
                b'{"version":2,"revision":1,"labels":{}}',
                b'{"version":1,"revision":true,"labels":{}}',
            ):
                path.write_bytes(invalid)
                with self.assertRaises(labels.LabelError):
                    store.read()
                with self.assertRaises(labels.LabelError):
                    store.update("1", "Inbox", {"1"}, 0)
                self.assertEqual(path.read_bytes(), invalid)
            path.unlink()
            target = root / "target"
            target.write_bytes(original)
            path.symlink_to(target)
            with self.assertRaises(OSError):
                store.read()
            self.assertEqual(target.read_bytes(), original)
            path.unlink()
            path.write_bytes(original)
            path.chmod(0o644)
            with self.assertRaises(labels.LabelError):
                store.read()

    def test_single_prompt_and_normalized_unchanged_edits_are_noops(self):
        with tempfile.TemporaryDirectory() as temp:
            store = labels.Store(Path(temp).resolve() / "state")
            self.assertTrue(store.update("1", "Cafe\u0301", {"1"}, 0))
            self.assertFalse(store.update("1", "Café", {"1"}, 1))
            self.assertEqual(store.read()["revision"], 1)
            with (
                store.directory() as directory,
                store.locked(directory, "prompt.lock", wait=False),
            ):
                with self.assertRaises(labels.LabelError):
                    with store.locked(directory, "prompt.lock", wait=False):
                        self.fail("A second prompt was admitted")


class LabelRenderingTests(unittest.TestCase):
    def test_alias_keeps_identity_badge_and_complete_app_popup(self):
        groups = {"1": [], "os-finances": [("org.app", "Example", 7)]}
        aliases = {"1": "Mail", "os-finances": "Finance notes"}
        args, _ = w.plan(groups, "os-finances", set(), 1000, 1, aliases=aliases)
        props = properties(args)
        self.assertIn("icon=1", props[w.header("1", 1)])
        self.assertIn("label=Mail", props[w.header("1", 1)])
        self.assertIn("label=Finance notes", props[w.header("os-finances", 1)])
        self.assertIn(
            "label=Example", props[w.item_id("popup", "os-finances", "org.app", 1)]
        )
        rename = props[w.item_id("rename", "1", display=1)]
        self.assertIn("label=Rename label…", rename)
        self.assertIn("label=Reset label", props[w.item_id("reset", "1", display=1)])
        click = next(
            x
            for x in props[w.header("os-finances", 1)]
            if x.startswith("click_script=")
        )
        self.assertIn("workspace os-finances", click)
        self.assertNotIn("Finance notes", click)

    def test_only_changed_header_width_is_written_and_narrow_actions_exist(self):
        widths = {}
        initial, _ = w.plan({"1": [], "2": []}, "1", set(), 1000, 1, widths=widths)
        existing = set(properties(initial))
        updated, _ = w.plan(
            {"1": [], "2": []},
            "1",
            existing,
            1000,
            1,
            aliases={"1": "Mail"},
            widths=widths,
        )
        props = properties(updated)
        self.assertIn("width=88", props[w.header("1", 1)])
        self.assertFalse(any(p.startswith("width=") for p in props[w.header("2", 1)]))
        again, _ = w.plan(
            {"1": [], "2": []},
            "1",
            existing,
            1000,
            1,
            aliases={"1": "Mail"},
            widths=widths,
        )
        self.assertFalse(any(p.startswith("width=") for p in again))
        narrow, _ = w.plan(
            {"1": [], "2": []}, "1", existing, 60, 1, aliases={"1": "Mail"}
        )
        props = properties(narrow)
        self.assertIn(
            "label=Rename Mail…", props[w.item_id("renameentry", "1", display=1)]
        )
        self.assertIn(
            "label=Rename 2…", props[w.item_id("renameentry", "2", display=1)]
        )


class LabelInteractionTests(unittest.TestCase):
    def test_cancel_never_saves_and_save_uses_clicked_identity_with_literal_data(self):
        with tempfile.TemporaryDirectory() as temp:
            store = labels.Store(Path(temp).resolve() / "state")
            calls = []
            answer = "CANCEL\n"

            def execute(args, **kwargs):
                calls.append(args)
                output = json.dumps([{"workspace": "1"}, {"workspace": "os-finances"}])
                if args[0] == "/usr/bin/osascript":
                    output = answer
                return subprocess.CompletedProcess(args, 0, stdout=output, stderr="")

            self.assertEqual(
                labels.edit("rename", "os-finances", "5", store, execute), 0
            )
            self.assertEqual(store.read()["revision"], 0)
            self.assertFalse(any("--trigger" in args for args in calls))
            answer = "SAVE\nFinance '; $(bad) `x`\n"
            self.assertEqual(
                labels.edit("rename", "os-finances", "5", store, execute), 0
            )
            self.assertEqual(
                store.read()["labels"], {"os-finances": "Finance '; $(bad) `x`"}
            )
            prompt = next(args for args in calls if args[0] == "/usr/bin/osascript")
            self.assertEqual(prompt[-3:], ["os-finances", "os-finances", "5"])
            self.assertTrue(any("--trigger" in args for args in calls))
            self.assertTrue(
                all(
                    args[1:4] == ["list-workspaces", "--all", "--json"]
                    for args in calls
                    if args[0] == labels.AEROSPACE
                )
            )

    def test_prompt_releases_state_lock_and_rejects_stale_save(self):
        with tempfile.TemporaryDirectory() as temp:
            store = labels.Store(Path(temp).resolve() / "state")
            calls = []

            def execute(args, **kwargs):
                calls.append(args)
                self.assertFalse(kwargs.get("shell", False))
                if args[0] == labels.AEROSPACE:
                    output = '[{"workspace":"1"},{"workspace":"2"}]'
                elif args[2] == "rename":
                    # A second writer can save while the human is thinking.
                    store.update("2", "Other writer", {"1", "2"}, 0)
                    output = "SAVE\nStale answer\n"
                else:
                    output = "ERROR\n"
                return subprocess.CompletedProcess(args, 0, stdout=output, stderr="")

            self.assertEqual(labels.edit("rename", "1", "1", store, execute), 1)
            self.assertEqual(store.read()["labels"], {"2": "Other writer"})
            self.assertFalse(any("--trigger" in args for args in calls))
            self.assertNotIn("Stale answer", calls[-1][-1])

    def test_timeout_missing_workspace_and_reset_do_not_mutate_aerospace(self):
        with tempfile.TemporaryDirectory() as temp:
            store = labels.Store(Path(temp).resolve() / "state")
            store.update("1", "Mail", {"1", "2"}, 0)
            calls = []
            timeout = True
            available = True

            def execute(args, **kwargs):
                calls.append(args)
                if args[0] == labels.AEROSPACE:
                    output = '[{"workspace":"1"}]' if available else "[]"
                elif args[0] == "/usr/bin/osascript" and args[2] == "rename":
                    self.assertEqual(args[-3:], ["1", "Mail", "1"])
                    if timeout:
                        raise subprocess.TimeoutExpired(args, kwargs["timeout"])
                    output = "SAVE\nChanged\n"
                else:
                    output = ""
                return subprocess.CompletedProcess(args, 0, stdout=output, stderr="")

            self.assertEqual(labels.edit("rename", "1", "1", store, execute), 1)
            self.assertEqual(store.read()["labels"], {"1": "Mail"})
            available = False
            self.assertEqual(labels.edit("reset", "1", "1", store, execute), 1)
            self.assertEqual(store.read()["labels"], {"1": "Mail"})
            available = True
            calls.clear()
            self.assertEqual(labels.edit("reset", "1", "1", store, execute), 0)
            self.assertEqual(store.read()["labels"], {})
            self.assertFalse(any(args[0] == "/usr/bin/osascript" for args in calls))
            calls.clear()
            self.assertEqual(labels.edit("reset", "1", "1", store, execute), 0)
            self.assertFalse(any("--trigger" in args for args in calls))

    def test_repeated_click_does_not_spawn_additional_dialogs(self):
        with tempfile.TemporaryDirectory() as temp:
            store = labels.Store(Path(temp).resolve() / "state")
            with (
                store.directory() as directory,
                store.locked(directory, "prompt.lock", wait=False),
            ):
                with patch.object(
                    labels.subprocess,
                    "run",
                    side_effect=AssertionError("second dialog"),
                ) as execute:
                    self.assertEqual(labels.edit("rename", "1", "1", store, execute), 0)
                    execute.assert_not_called()

    def test_cli_replaces_inherited_script_alarm_with_its_own_dialog_deadline(self):
        with tempfile.TemporaryDirectory() as temp:

            def execute(args, **kwargs):
                output = (
                    '[{"workspace":"1"}]' if args[0] == labels.AEROSPACE else "CANCEL\n"
                )
                return subprocess.CompletedProcess(args, 0, stdout=output, stderr="")

            signal.alarm(30)
            try:
                with patch.object(
                    labels.Path, "home", return_value=Path(temp).resolve()
                ):
                    self.assertEqual(labels.main(["rename", "1", "1"], execute), 0)
                self.assertEqual(signal.alarm(0), 0)
            finally:
                signal.alarm(0)

    def test_invalid_collision_stale_and_unavailable_leave_state_intact(self):
        with tempfile.TemporaryDirectory() as temp:
            store = labels.Store(Path(temp).resolve() / "state")
            for answer in ("", "   ", "next\nline", "a" * 41, "\u202eevil", "1"):
                with self.subTest(answer=answer), self.assertRaises(labels.LabelError):
                    store.update("os-finances", answer, {"1", "os-finances"}, 0)
            store.update("os-finances", "Finances", {"1", "os-finances"}, 0)
            with self.assertRaises(labels.LabelError):
                store.update("1", "FINANCES", {"1", "os-finances"}, 1)
            with self.assertRaises(labels.LabelError):
                store.update("os-finances", "Changed", {"1", "os-finances"}, 0)
            with self.assertRaises(labels.LabelError):
                store.update("missing", "Changed", {"1"}, 1)
            self.assertEqual(store.read()["labels"], {"os-finances": "Finances"})


class LabelReconciliationTests(unittest.TestCase):
    def test_saved_changes_and_corrupt_state_reconcile_without_identity_churn(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp).resolve()
            panel = {
                "arrangement": 1,
                "screen": 2,
                "left": 180,
                "right": 400,
                "width": 900,
            }
            names = {"apple", w.header("1", 1), w.header("2", 1)}
            actual_widths = {w.header("1", 1): 28, w.header("2", 1): 28}
            batches = []

            def execute(args):
                if args[:3] == ["sketchybar", "--query", "bar"]:
                    return json.dumps({"items": list(names)})
                if args[:2] == ["sketchybar", "--query"]:
                    return json.dumps({"geometry": {"width": actual_widths[args[2]]}})
                if args[0] == w.AEROSPACE:
                    if args[1] == "list-monitors":
                        return json.dumps(
                            [{"monitor-id": 9, "monitor-appkit-nsscreen-screens-id": 2}]
                        )
                    if args[1] == "list-windows":
                        return json.dumps(
                            [
                                {
                                    "workspace": "2",
                                    "app-bundle-id": "org.app",
                                    "app-name": "Example",
                                    "window-id": 7,
                                }
                            ]
                        )
                    if "--json" in args:
                        return json.dumps(
                            [{"workspace": "1"}]
                            if "--visible" in args
                            else [{"workspace": "1"}, {"workspace": "2"}]
                        )
                    return "1\n"
                self.assertEqual(args[0], "sketchybar")
                batches.append(args)
                for i, arg in enumerate(args):
                    if arg == "--remove":
                        names.discard(args[i + 1])
                for name, props in properties(args).items():
                    names.add(name)
                    for prop in props:
                        if prop.startswith("width=") and name in actual_widths:
                            actual_widths[name] = int(prop[6:])
                return ""

            with (
                patch.object(w.Path, "home", return_value=home),
                patch.object(w, "geometry", return_value=[panel]),
                patch.object(w, "run", side_effect=execute),
            ):
                store = labels.Store()
                w.reconcile()
                self.assertFalse(
                    any(
                        p.startswith("width=")
                        for p in properties(batches[-1])[w.header("1", 1)]
                    )
                )
                store.update("1", "Secret finance", {"1", "2"}, 0)
                w.reconcile()
                first_changed = batches[-1]
                self.assertIn(
                    "label=Secret finance", properties(first_changed)[w.header("1", 1)]
                )
                self.assertEqual(actual_widths[w.header("1", 1)], 208)
                self.assertNotIn("--remove", first_changed)
                self.assertIn(
                    w.item_id("renameentry", "1", display=1), properties(first_changed)
                )
                w.reconcile()
                self.assertFalse(any(p.startswith("width=") for p in batches[-1]))
                for cache in (home / ".cache/sketchybar-workspaces").iterdir():
                    self.assertNotIn("Secret finance", cache.read_text())
                (store.root / "workspace-labels.json").write_text("{")
                w.reconcile()
                self.assertEqual(actual_widths[w.header("1", 1)], 28)
                self.assertIn(
                    "label.drawing=off", properties(batches[-1])[w.header("1", 1)]
                )
                self.assertEqual(
                    (store.root / "workspace-labels.json").read_text(), "{"
                )


if __name__ == "__main__":
    unittest.main()
