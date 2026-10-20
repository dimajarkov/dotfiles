#!/usr/bin/env python3
"""Synthetic membership/controller tests; never query or change the live bar."""
import contextlib
import importlib.util
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "home/.config/sketchybar/plugins/workspaces.py"
spec = importlib.util.spec_from_file_location("workspaces", SOURCE)
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


def window(ws="1", bundle="org.test.App", name="Test", number=1):
    return {"workspace": ws, "app-bundle-id": bundle, "app-name": name, "window-id": number}


def snapshot(windows=(), spaces=(), focused="1"):
    with patch.object(w, "query", side_effect=[list(spaces), list(windows)]), patch.object(w, "run", return_value=focused):
        return w.snapshot()


def sets(args):
    result = {}
    index = 0
    while index < len(args):
        if args[index] == "--set":
            name = args[index + 1]
            index += 2
            props = []
            while index < len(args) and not args[index].startswith("--"):
                props.append(args[index])
                index += 1
            result[name] = props
        else:
            index += 1
    return result


class MembershipTests(unittest.TestCase):
    def test_query_contract_and_empty_workspaces(self):
        with patch.object(w, "query", side_effect=[[], []]) as query, patch.object(w, "run", return_value="2\n") as run:
            groups, focused = w.snapshot()
        self.assertEqual(list(groups), list(map(str, range(1, 8))))
        self.assertEqual(focused, "2")
        self.assertEqual(query.call_args_list[1].args[0], [w.AEROSPACE, "list-windows", "--all", "--json", "--format", "%{workspace}%{app-bundle-id}%{app-name}%{window-id}"])
        self.assertEqual(run.call_args.args[0], [w.AEROSPACE, "list-workspaces", "--focused"])

    def test_dedupe_shared_apps_and_stable_order(self):
        rows = [window(number=8), window(number=2), window("2"), window(bundle="aaa"), window("10"), window("other")]
        a, _ = snapshot(rows, [{"workspace": "empty"}])
        b, _ = snapshot(reversed(rows), [{"workspace": "empty"}])
        self.assertEqual(a, b)
        self.assertEqual(a["1"], [("aaa", "Test", 1), ("org.test.App", "Test", 2)])
        self.assertEqual(len(a["2"]), 1)
        self.assertEqual(list(a)[-3:], ["10", "empty", "other"])

    def test_invalid_snapshot_is_not_empty(self):
        for value in [0, -1, "1;echo bad", True, None]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                snapshot([window(number=value)])
        with patch.object(w, "query", side_effect=[{}, []]), patch.object(w, "run", return_value="1"), self.assertRaises(ValueError):
            w.snapshot()

    def test_safe_ids_and_shell_quoting(self):
        ws = "x'; touch /tmp/nope; #"
        bundle = "org.test.'; $bad"
        groups, _ = snapshot([window(ws, bundle, "Name ' $x")])
        args, _ = w.plan(groups, ws, {"apple"}, 600)
        for name in sets(args):
            self.assertRegex(name, r"^(space\.[1-7]|wsc\.[a-z]+\.[a-f0-9]{24})$")
        props = sets(args)[w.header(ws)]
        click = next(p.split("=", 1)[1] for p in props if p.startswith("click_script="))
        self.assertIn(shlex.quote(ws), click)
        # Exercise the shell parser with a fake AeroSpace function, not eval.
        click = click.replace(w.AEROSPACE, "capture")
        output = subprocess.check_output(["/bin/sh", "-c", 'capture() { printf "%s\\n" "$@"; }; BUTTON=left; ' + click], text=True)
        self.assertEqual(output.splitlines(), ["workspace", ws])
        app_props = sets(args)[w.item_id("app", ws, bundle)]
        self.assertIn("click_script=" + w.AEROSPACE + " focus --window-id 1", app_props)

    def test_native_images_geometry_selection(self):
        groups, _ = snapshot([window()])
        args, images = w.plan(groups, "1", {"apple"}, 600)
        props = sets(args)
        self.assertIn("background.color=" + w.SURFACE, props["space.1"])
        self.assertIn("icon.color=" + w.RED, props["space.1"])
        self.assertIn("background.color=" + w.CLEAR, props["space.2"])
        for name in images:
            self.assertIn("background.image=app.org.test.App", props[name])
            self.assertIn("background.image.scale=0.6", props[name])
            self.assertIn("background.height=24", props[name])
            self.assertIn("background.drawing=on", props[name])
        self.assertIn("label.drawing=off", props[w.item_id("app", "1", "org.test.App")])
        self.assertIn("label=Test", props[w.item_id("popup", "1", "org.test.App")])

    def test_removals_moves_and_group_order(self):
        old, _ = snapshot([window()])
        previous, _ = w.plan(old, "1", {"apple"}, 600)
        existing = set(sets(previous)) | {"apple", "clock", "date", "battery", "volume", "workspace_controller", "display_controller", "unrelated"}
        new, _ = snapshot([window("2")])
        args, _ = w.plan(new, "2", existing, 600)
        removals = [args[i + 1] for i, value in enumerate(args) if value == "--remove"]
        self.assertEqual(set(removals), {w.item_id("app", "1", "org.test.App"), w.item_id("popup", "1", "org.test.App")})
        order = args[args.index("--reorder") + 1:]
        self.assertEqual(order[:4], ["apple", "space.1", "space.2", w.item_id("app", "2", "org.test.App")])
        self.assertEqual(order[-4:], ["clock", "date", "battery", "volume"])
        self.assertNotIn("unrelated", removals)

    def test_overflow_discloses_every_app(self):
        groups, _ = snapshot([window(str(ws), "org.test.App" + str(app), "App " + str(app), app + 1)
                              for ws in range(1, 8) for app in range(20)])
        counts = w.allocation(groups, 600)
        total_height = 7 * w.HEADER_HEIGHT + sum(counts.values()) * w.ROW_HEIGHT + 7 * w.ROW_HEIGHT
        self.assertLessEqual(total_height, 600)
        args, _ = w.plan(groups, "1", {"apple"}, 600)
        props = sets(args)
        self.assertEqual(sum(name.startswith("wsc.popup.") for name in props), 140)
        for ws, apps in groups.items():
            self.assertIn("icon=+" + str(len(apps) - counts[ws]), props[w.item_id("more", ws)])
            self.assertIn("popup.align=left", props[w.header(ws)])
        self.assertLessEqual(max(counts.values()) - min(counts.values()), 1)

    def test_display_budget_and_fallback(self):
        with patch.object(w, "run", side_effect=["[]", "700"]):
            self.assertEqual(w.inline_budget(), 340)
        with patch.object(w, "run", side_effect=OSError):
            self.assertEqual(w.inline_budget(), 600)
        with patch.object(w, "run", side_effect=["[]", "982"]):
            self.assertEqual(w.inline_budget(), 600)

    def test_unavailable_preserves_membership_then_recovers(self):
        groups, _ = snapshot([window()])
        existing = {"apple", "space.1", w.item_id("app", "1", "org.test.App")}
        with patch.object(w, "lock", return_value=contextlib.nullcontext()), patch.object(w, "query", return_value={"items": list(existing)}), patch.object(w, "snapshot", side_effect=ValueError), patch.object(w, "run") as run:
            w.render()
        args = run.call_args.args[0]
        self.assertNotIn("--remove", args)
        self.assertNotIn("--add", args)
        self.assertIn("icon.color=" + w.MUTED, args)
        self.assertIn("background.color=" + w.CLEAR, args)
        with patch.object(w, "lock", return_value=contextlib.nullcontext()), patch.object(w, "query", return_value={"items": list(existing)}), patch.object(w, "snapshot", return_value=(groups, "1")), patch.object(w, "inline_budget", return_value=600), patch.object(w, "run") as run:
            w.render()
        self.assertIn("icon.color=" + w.RED, run.call_args.args[0])

    def test_native_image_error_clears_stale_images(self):
        groups, _ = snapshot([window()])
        with patch.object(w, "lock", return_value=contextlib.nullcontext()), patch.object(w, "query", return_value={"items": ["apple"]}), patch.object(w, "snapshot", return_value=(groups, "1")), patch.object(w, "inline_budget", return_value=600), patch.object(w, "run", side_effect=[subprocess.CalledProcessError(1, "sketchybar"), subprocess.CalledProcessError(1, "image"), "", ""]) as run:
            w.render()
        fallback = run.call_args.args[0]
        self.assertIn("background.image=none", fallback)
        self.assertIn("icon=?", fallback)
        self.assertNotIn(w.item_id("app", "1", "org.test.App"), fallback)

    def test_private_lock_and_symlink_rejection(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(w.Path, "home", return_value=Path(temp)):
            with w.lock("render.lock"):
                with self.assertRaises(TimeoutError), w.lock("render.lock", wait=False):
                    pass
            root = Path(temp) / ".cache/sketchybar-workspaces"
            self.assertEqual(root.stat().st_mode & 0o777, 0o700)
            (root / "render.lock").unlink()
            (root / "render.lock").symlink_to(Path(temp) / "target")
            with self.assertRaises(OSError), w.lock("render.lock"):
                pass
            self.assertFalse((Path(temp) / "target").exists())

    def test_watch_real_child_debounces_and_reaps(self):
        real_popen = subprocess.Popen
        children, handlers, triggers = [], {}, []

        def spawn(args, **kwargs):
            self.assertEqual(args, [w.AEROSPACE, "subscribe", *w.EVENTS])
            child = real_popen([sys.executable, "-c", 'import time; print("event\\n" * 40, flush=True); time.sleep(30)'], **kwargs)
            children.append(child)
            return child

        def trigger():
            triggers.append(w.time.monotonic())
            if len(triggers) == 2:
                handlers[signal.SIGTERM](signal.SIGTERM, None)

        with patch.object(w, "lock", return_value=contextlib.nullcontext()), patch.object(w.signal, "signal", side_effect=lambda sig, handler: handlers.update({sig: handler})), patch.object(w.subprocess, "Popen", side_effect=spawn), patch.object(w, "trigger", side_effect=trigger):
            w.watch()
        self.assertEqual(len(children), 1)
        self.assertEqual(len(triggers), 3)  # startup, coalesced burst, trailing refresh
        self.assertGreaterEqual(triggers[1] - triggers[0], 0.19)
        self.assertIsNotNone(children[0].poll())
        self.assertTrue(children[0].stdout.closed)


if __name__ == "__main__":
    unittest.main()
