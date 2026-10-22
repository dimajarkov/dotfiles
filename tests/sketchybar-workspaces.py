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

SOURCE = (
    Path(__file__).resolve().parents[1]
    / "home/.config/sketchybar/plugins/workspaces.py"
)
spec = importlib.util.spec_from_file_location("workspaces", SOURCE)
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


class NativeGeometryTests(unittest.TestCase):
    def native(self, **changes):
        return dict(
            arrangement=1,
            screen=2,
            width=1512,
            origin=-500,
            top=32,
            leftArea=[-500, 663, 32],
            rightArea=[348, 664, 32],
            **changes,
        )

    def test_native_negative_origin(self):
        import display

        result = display.normalize(self.native())
        self.assertEqual((result["left"], result["right"]), (663, 848))

    def test_invalid_native_rectangles(self):
        import display

        for changes in (
            {"leftArea": [0, 0, 0], "rightArea": [0, 0, 0]},
            {"rightArea": [100, 664, 32]},
            {"leftArea": [-501, 663, 32]},
            {"leftArea": [-500, 663, 0]},
        ):
            value = self.native()
            value.update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                display.normalize(value)

    def test_unnotched_center_split(self):
        import display

        value = self.native()
        value.update(top=0, leftArea=None, rightArea=None)
        result = display.normalize(value)
        self.assertEqual(result["left"], result["right"])

    def test_display_recovery(self):
        import display

        with (
            patch.object(display, "geometry", side_effect=[ValueError(), DISPLAY]),
            patch.object(display.subprocess, "run") as run,
        ):
            display.reconcile()
            self.assertIn("hidden=on", run.call_args.args[0])
            display.reconcile()
            self.assertIn("hidden=off", run.call_args.args[0])
        config = (SOURCE.parent.parent / "sketchybarrc").read_text()
        self.assertIn(
            "display_controller drawing=off updates=on update_freq=30", config
        )


def window(ws="1", bundle="org.test.App", name="Test", number=1):
    return {
        "workspace": ws,
        "app-bundle-id": bundle,
        "app-name": name,
        "window-id": number,
    }


MONITORS = [
    {"monitor-id": 9, "monitor-appkit-nsscreen-screens-id": 2},
    {"monitor-id": 1, "monitor-appkit-nsscreen-screens-id": 1},
]
DISPLAY = {"arrangement": 1, "screen": 2, "left": 650, "right": 850, "width": 1500}


def snapshot(windows=(), spaces=None, focused="1"):
    rows = list(windows)
    if spaces is None:
        spaces = [
            {"workspace": ws}
            for ws in sorted(
                set(map(str, range(1, 8))) | {row["workspace"] for row in rows},
                key=w.workspace_key,
            )
        ]
    with (
        patch.object(w, "geometry", return_value=DISPLAY),
        patch.object(w, "query", side_effect=[MONITORS, list(spaces), rows]),
        patch.object(w, "run", return_value=focused),
    ):
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
            result.setdefault(name, []).extend(props)
        else:
            index += 1
    return result


class MembershipTests(unittest.TestCase):
    def test_query_contract_and_empty_workspaces(self):
        with (
            patch.object(w, "geometry", return_value=DISPLAY),
            patch.object(
                w, "query", side_effect=[MONITORS, [{"workspace": "empty"}], []]
            ) as query,
            patch.object(w, "run", return_value="2\n") as run,
        ):
            groups, focused = w.snapshot()
        self.assertEqual(list(groups), ["empty"])
        self.assertEqual(
            query.call_args_list[1].args[0],
            [w.AEROSPACE, "list-workspaces", "--monitor", "9", "--json"],
        )
        self.assertEqual(focused, "2")
        self.assertEqual(
            query.call_args_list[2].args[0],
            [
                w.AEROSPACE,
                "list-windows",
                "--all",
                "--json",
                "--format",
                "%{workspace}%{app-bundle-id}%{app-name}%{window-id}",
            ],
        )
        self.assertEqual(
            run.call_args.args[0], [w.AEROSPACE, "list-workspaces", "--focused"]
        )

    def test_dedupe_shared_apps_and_stable_order(self):
        rows = [
            window(number=8),
            window(number=2),
            window("2"),
            window(bundle="aaa"),
            window("10"),
            window("other"),
        ]
        spaces = [{"workspace": ws} for ws in ["1", "2", "10", "empty", "other"]]
        a, _ = snapshot(rows, spaces)
        b, _ = snapshot(reversed(rows), spaces)
        self.assertEqual(a, b)
        self.assertEqual(a["1"], [("aaa", "Test", 1), ("org.test.App", "Test", 2)])
        self.assertEqual(len(a["2"]), 1)
        self.assertEqual(list(a)[-3:], ["10", "empty", "other"])

    def test_external_workspaces_and_windows_are_excluded(self):
        groups, focused = snapshot(
            [window("1"), window("external")],
            [{"workspace": "1"}, {"workspace": "empty"}],
            focused="external",
        )
        self.assertEqual(list(groups), ["1", "empty"])
        self.assertEqual(groups["empty"], [])
        args, _ = w.plan(groups, focused, {"apple"}, 600)
        self.assertNotIn("icon.color=" + w.RED, args)

    def test_no_builtin_never_invents_workspaces(self):
        with (
            patch.object(w, "geometry", return_value=None),
            patch.object(w, "query") as query,
        ):
            self.assertEqual(w.snapshot(), ({}, ""))
        query.assert_not_called()

    def test_compact_popup_keeps_all_workspaces_and_native_apps(self):
        groups, _ = snapshot([window()])
        args, images = w.plan(groups, "1", {"apple"}, 80)
        props = sets(args)
        self.assertIn("icon=+7", props["wsc.overflow"])
        for ws in groups:
            self.assertIn("drawing=off", props[w.header(ws)])
            self.assertIn("label=Workspace " + ws, props[w.item_id("entry", ws)])
        entry = w.item_id("entry", "1", "org.test.App")
        self.assertIn("icon.background.image=app.org.test.App", props[entry])
        self.assertIn(entry, images)
        self.assertIn("popup.drawing=toggle", " ".join(props["wsc.overflow"]))
        zero, _ = w.plan(groups, "1", {"apple"}, 0)
        self.assertNotIn("wsc.overflow", sets(zero))
        self.assertTrue(all("drawing=off" in sets(zero)[w.header(ws)] for ws in groups))

    def test_allocation_stays_within_horizontal_budget(self):
        groups = {
            "1": [(str(i), "App", i + 1) for i in range(50)],
            "2": [],
            "3": [("other", "Other", 99)],
        }
        minimum = sum(w.group_width(apps, 0) for apps in groups.values())
        for budget in range(minimum, 1600):
            counts = w.allocation(groups, budget, "3")
            self.assertLessEqual(
                sum(w.group_width(apps, counts[ws]) for ws, apps in groups.items()),
                budget,
            )
        counts = w.allocation(groups, minimum, "3")
        # Replacing a +1 disclosure with one native image costs less, not more.
        self.assertEqual(counts["3"], 1)

    def test_brackets_use_explicit_membership_and_fixed_gaps(self):
        groups, _ = snapshot([window()])
        args, _ = w.plan(groups, "1", {"apple"}, 600)
        index = args.index("bracket")
        self.assertEqual(
            args[index + 1 : index + 4],
            [w.item_id("group", "1"), "space.1", w.item_id("app", "1", "org.test.App")],
        )
        props = sets(args)
        self.assertIn("width=8", props[w.item_id("gap", "1")])
        self.assertIn("background.corner_radius=7", props[w.item_id("group", "1")])

    def test_new_native_item_rebuilds_bracket_before_removing_old_members(self):
        groups, _ = snapshot([window()])
        first, _ = w.plan(groups, "1", {"apple"}, 600)
        existing = set(sets(first)) | {"apple"}
        groups, _ = snapshot([window(), window(bundle="org.new", number=2)])
        args, _ = w.plan(groups, "1", existing, 600)
        bracket = w.item_id("group", "1")
        remove = args.index("--remove")
        self.assertEqual(args[remove + 1], bracket)
        add = args.index("bracket")
        self.assertGreater(add, remove)
        self.assertIn(w.item_id("app", "1", "org.new"), args[add + 2 : add + 5])

    def test_invalid_snapshot_is_not_empty(self):
        for value in [0, -1, "1;echo bad", True, None]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                snapshot([window(number=value)])
        with (
            patch.object(w, "geometry", return_value=DISPLAY),
            patch.object(w, "query", side_effect=[MONITORS, {}, []]),
            patch.object(w, "run", return_value="1"),
            self.assertRaises(ValueError),
        ):
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
        output = subprocess.check_output(
            [
                "/bin/sh",
                "-c",
                'capture() { printf "%s\\n" "$@"; }; BUTTON=left; ' + click,
            ],
            text=True,
        )
        self.assertEqual(output.splitlines(), ["workspace", ws])
        app_props = sets(args)[w.item_id("app", ws, bundle)]
        self.assertIn("click_script=" + w.AEROSPACE + " focus --window-id 1", app_props)

    def test_native_images_geometry_selection(self):
        groups, _ = snapshot([window()])
        args, images = w.plan(groups, "1", {"apple"}, 600)
        props = sets(args)
        self.assertIn("background.color=" + w.ACTIVE, props[w.item_id("group", "1")])
        self.assertIn(
            "background.border_color=" + w.RED, props[w.item_id("group", "1")]
        )
        self.assertIn("icon.color=" + w.RED, props["space.1"])
        self.assertIn("background.color=" + w.INACTIVE, props[w.item_id("group", "2")])
        for name in images:
            prefix = (
                "icon.background.image"
                if name.startswith("wsc.popup.")
                else "background.image"
            )
            self.assertIn(prefix + "=app.org.test.App", props[name])
            self.assertIn(prefix + ".scale=0.6", props[name])
            self.assertIn(prefix + "=", props[name])
            self.assertNotIn(prefix + "=none", props[name])
            self.assertIn("background.height=24", props[name])
            self.assertIn("background.drawing=on", props[name])
        self.assertIn("width=24", props[w.item_id("app", "1", "org.test.App")])
        self.assertIn("label.drawing=off", props[w.item_id("app", "1", "org.test.App")])
        self.assertIn("label=Test", props[w.item_id("popup", "1", "org.test.App")])

    def test_refresh_does_not_queue_dynamic_width_animations(self):
        groups, _ = snapshot([window()])
        first, _ = w.plan(groups, "1", {"apple"}, 600)
        existing = set(sets(first)) | {"apple"}
        refresh, _ = w.plan(groups, "1", existing, 600)
        self.assertFalse(any(prop.startswith("width=") for prop in refresh))
        self.assertNotIn("--add", refresh)

    def test_removals_moves_and_group_order(self):
        old, _ = snapshot([window()])
        previous, _ = w.plan(old, "1", {"apple"}, 600)
        existing = set(sets(previous)) | {
            "apple",
            "clock",
            "date",
            "battery",
            "volume",
            "workspace_controller",
            "display_controller",
            "unrelated",
        }
        new, _ = snapshot([window("2")])
        args, _ = w.plan(new, "2", existing, 600)
        removals = [args[i + 1] for i, value in enumerate(args) if value == "--remove"]
        self.assertEqual(
            set(removals),
            {
                w.item_id("app", "1", "org.test.App"),
                w.item_id("popup", "1", "org.test.App"),
                w.item_id("group", "1"),
                w.item_id("group", "2"),
            },
        )
        order = args[args.index("--reorder") + 1 :]
        self.assertEqual(
            order[:5],
            [
                "apple",
                "space.1",
                w.item_id("gap", "1"),
                "space.2",
                w.item_id("app", "2", "org.test.App"),
            ],
        )
        self.assertEqual(order[-4:], ["clock", "date", "battery", "volume"])
        self.assertNotIn("unrelated", removals)

    def test_overflow_discloses_every_app(self):
        groups, _ = snapshot(
            [
                window(str(ws), "org.test.App" + str(app), "App " + str(app), app + 1)
                for ws in range(1, 8)
                for app in range(20)
            ]
        )
        counts = w.allocation(groups, 600, "1")
        total_width = sum(
            w.group_width(apps, counts[ws]) for ws, apps in groups.items()
        )
        self.assertLessEqual(total_width, 600)
        self.assertGreater(counts["1"], counts["2"])
        args, _ = w.plan(groups, "1", {"apple"}, 600)
        props = sets(args)
        self.assertEqual(sum(name.startswith("wsc.popup.") for name in props), 140)
        for ws, apps in groups.items():
            self.assertIn(
                "icon=+" + str(len(apps) - counts[ws]), props[w.item_id("more", ws)]
            )
            self.assertIn("popup.align=left", props[w.header(ws)])
        self.assertTrue(all(counts[ws] == 0 for ws in groups if ws != "1"))

    def test_display_budget_and_fallback(self):
        for left in (300, 650, 900):
            with patch.object(w, "geometry", return_value={**DISPLAY, "left": left}):
                self.assertEqual(w.inline_budget(), left - 48)
        with patch.object(w, "geometry", side_effect=OSError):
            self.assertEqual(w.inline_budget(), 0)
        with patch.object(w, "geometry", return_value=None):
            self.assertEqual(w.inline_budget(), 0)

    def test_unavailable_preserves_membership_then_recovers(self):
        groups, _ = snapshot([window()])
        existing = {"apple", "space.1", w.item_id("app", "1", "org.test.App")}
        with (
            patch.object(w, "lock", return_value=contextlib.nullcontext()),
            patch.object(w, "query", return_value={"items": list(existing)}),
            patch.object(w, "snapshot", side_effect=ValueError),
            patch.object(w, "run") as run,
        ):
            w.render()
        args = run.call_args.args[0]
        self.assertNotIn("--remove", args)
        self.assertNotIn("--add", args)
        self.assertIn("icon.color=" + w.MUTED, args)
        self.assertIn("background.color=" + w.CLEAR, args)
        with (
            patch.object(w, "lock", return_value=contextlib.nullcontext()),
            patch.object(w, "query", return_value={"items": list(existing)}),
            patch.object(w, "snapshot", return_value=(groups, "1")),
            patch.object(w, "inline_budget", return_value=600),
            patch.object(w, "run") as run,
        ):
            w.render()
        self.assertIn("icon.color=" + w.RED, run.call_args.args[0])

    def test_native_image_error_clears_stale_images(self):
        groups, _ = snapshot([window()])
        with (
            patch.object(w, "lock", return_value=contextlib.nullcontext()),
            patch.object(w, "query", return_value={"items": ["apple"]}),
            patch.object(w, "snapshot", return_value=(groups, "1")),
            patch.object(w, "inline_budget", return_value=600),
            patch.object(
                w,
                "run",
                side_effect=[
                    subprocess.CalledProcessError(1, "sketchybar"),
                    subprocess.CalledProcessError(1, "image"),
                    "",
                    "",
                ],
            ) as run,
        ):
            w.render()
        fallback = run.call_args.args[0]
        self.assertIn("icon.background.image=", fallback)
        self.assertIn("icon.background.image.drawing=off", fallback)
        self.assertIn("icon=?", fallback)
        self.assertNotIn(w.item_id("app", "1", "org.test.App"), fallback)

    def test_missing_icon_does_not_replace_valid_native_images(self):
        groups, _ = snapshot([window(), window(bundle="org.missing", number=2)])
        calls = []

        def native(args):
            calls.append(args)
            if "--add" in args or any(arg.endswith("=app.org.missing") for arg in args):
                raise subprocess.CalledProcessError(1, args)
            return ""

        with (
            patch.object(w, "lock", return_value=contextlib.nullcontext()),
            patch.object(w, "query", return_value={"items": ["apple"]}),
            patch.object(w, "snapshot", return_value=(groups, "1")),
            patch.object(w, "inline_budget", return_value=600),
            patch.object(w, "run", side_effect=native),
        ):
            w.render()
        fallback = sets(calls[-1][1:])
        self.assertEqual(
            set(fallback),
            {
                w.item_id("app", "1", "org.missing"),
                w.item_id("popup", "1", "org.missing"),
            },
        )
        self.assertIn(
            "background.image=", fallback[w.item_id("app", "1", "org.missing")]
        )
        self.assertIn(
            "icon.background.image=", fallback[w.item_id("popup", "1", "org.missing")]
        )

    def test_private_lock_and_symlink_rejection(self):
        with (
            tempfile.TemporaryDirectory() as temp,
            patch.object(w.Path, "home", return_value=Path(temp)),
        ):
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
            child = real_popen(
                [
                    sys.executable,
                    "-c",
                    'import time; print("event\\n" * 40, flush=True); time.sleep(30)',
                ],
                **kwargs,
            )
            children.append(child)
            return child

        def trigger():
            triggers.append(w.time.monotonic())
            if len(triggers) == 2:
                handlers[signal.SIGTERM](signal.SIGTERM, None)

        with (
            patch.object(w, "lock", return_value=contextlib.nullcontext()),
            patch.object(
                w.signal,
                "signal",
                side_effect=lambda sig, handler: handlers.update({sig: handler}),
            ),
            patch.object(w.subprocess, "Popen", side_effect=spawn),
            patch.object(w, "trigger", side_effect=trigger),
        ):
            w.watch()
        self.assertEqual(len(children), 1)
        self.assertEqual(len(triggers), 3)  # startup, coalesced burst, trailing refresh
        self.assertGreaterEqual(triggers[1] - triggers[0], 0.19)
        self.assertIsNotNone(children[0].poll())
        self.assertTrue(children[0].stdout.closed)


if __name__ == "__main__":
    unittest.main()
