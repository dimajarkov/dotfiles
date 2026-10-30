#!/usr/bin/env python3
"""Synthetic membership/controller tests; never query or change the live bar."""

import contextlib
import importlib.util
import json
import os
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


class ViewportTests(unittest.TestCase):
    def test_four_workspaces_and_extras_partition_for_every_selection(self):
        groups = {str(i): [] for i in range(1, 10)}
        manifest = {}
        args, _ = w.plan(groups, "1", set(), 600, 1, manifest)
        self.assertNotIn("mouse.scrolled", args)
        self.assertFalse(
            any(n.startswith(("wsc.prev.", "wsc.next.")) for n in sets(args))
        )
        for selected in groups:
            props = sets(w.viewport_args(manifest, {w.digest(selected)[:12]}))
            shown = w.viewport_rows(manifest["1"])
            self.assertEqual(len(shown), 4)
            self.assertIn(w.digest(selected)[:12], {r[0] for r in shown})
            for ws in groups:
                inline = props[w.header(ws, 1)][-1] == "drawing=on"
                entry = props[w.item_id("entry", ws, display=1)][-1] == "drawing=on"
                self.assertNotEqual(inline, entry)
            self.assertIn("label=Extras 5 ▾", props["wsc.overflow.d1"])

    def test_narrow_panels_and_large_groups_stay_in_budget(self):
        groups = {str(i): [(str(j), "App", j + 1) for j in range(50)] for i in range(7)}
        for budget in (120, 160, 300, 600):
            manifest = {}
            args, _ = w.plan(groups, "6", set(), budget, 1, manifest)
            shown = w.viewport_rows(manifest["1"])
            self.assertLessEqual(len(shown), 4)
            self.assertLessEqual(sum(row[1] for row in shown) + w.MORE_WIDTH, budget)
            props = sets(args)
            drawn_apps = [
                n
                for n, p in props.items()
                if n.startswith("wsc.app.") and p[-1] == "drawing=on"
            ]
            if shown:
                self.assertLessEqual(
                    len(drawn_apps) * w.APP_WIDTH
                    + w.HEADER_WIDTH
                    + w.GROUP_GAP
                    + w.MORE_WIDTH,
                    budget,
                )
            self.assertEqual(sum(n.startswith("wsc.popup.") for n in props), 350)

    def test_hidden_workspace_promoted_without_inventory_and_cache_is_private(self):
        groups = {"secret " + str(i): [] for i in range(8)}
        manifest = {}
        w.plan_all([(DISPLAY, groups, "secret 0")], set(), manifest)
        with (
            tempfile.TemporaryDirectory() as temp,
            patch.object(w.Path, "home", return_value=Path(temp)),
        ):
            w.save_viewports(manifest)
            cached = w.load_viewports()
            self.assertEqual(cached, manifest)
            self.assertNotIn("secret", json.dumps(cached))
            with patch.object(w, "query") as query:
                props = sets(w.viewport_args(cached, {w.digest("secret 7")[:12]}))
            query.assert_not_called()
            self.assertEqual(props[w.header("secret 7", 1)][-1], "drawing=on")

    def test_all_fit_hides_extras_and_small_fallback_still_discloses(self):
        groups = {str(i): [] for i in range(4)}
        args, _ = w.plan(groups, "0", set(), 160, 1)
        self.assertIn("drawing=off", sets(args)["wsc.overflow.d1"])
        args, _ = w.plan(groups, "0", set(), 50, 1)
        self.assertIn("icon=▾", sets(args)["wsc.overflow.d1"])
        self.assertEqual(sum(n.startswith("wsc.entry.") for n in sets(args)), 4)


class WorkspaceShortcutTests(unittest.TestCase):
    def test_only_main_option_number_bindings_are_read(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "aerospace.toml"
            path.write_text("""[mode.main.binding]
alt-1 = 'workspace 1'
alt-4 = 'workspace browse'
alt-7 = "workspace jobs"
alt-shift-7 = 'move-node-to-workspace jobs'
[mode.service.binding]
alt-8 = 'workspace hidden'
""")
            self.assertEqual(
                w.workspace_shortcuts(path), {"1": "1", "browse": "4", "jobs": "7"}
            )
            self.assertEqual(w.workspace_shortcuts(Path(temp) / "missing"), {})

    def test_labels_widths_order_and_click_targets(self):
        with patch.object(
            w,
            "WORKSPACE_SHORTCUTS",
            {"1": "1", "browse": "4", "jobs": "7", "os-finances": "5"},
        ):
            self.assertEqual(w.workspace_label("1"), "1")
            self.assertEqual(w.workspace_label("browse"), "4 browse")
            self.assertEqual(w.workspace_label("unbound"), "unbound")
            self.assertEqual(
                sorted(["jobs", "os-finances", "browse"], key=w.workspace_key),
                ["browse", "os-finances", "jobs"],
            )
            self.assertEqual(
                w.header_width("browse"), w.HEADER_WIDTH + len("browse") * 8 + 12
            )
            args, _ = w.plan({"browse": []}, "browse", set(), 1000)
            props = sets(args)[w.header("browse")]
            self.assertIn("icon=4", props)
            self.assertIn("label=browse", props)
            self.assertIn("label.drawing=on", props)
            self.assertIn("icon.background.drawing=on", props)
            self.assertIn("icon.background.height=" + str(w.ROW_HEIGHT), props)
            self.assertIn("icon.background.corner_radius=0", props)
            self.assertIn("icon.background.border_color=" + w.YELLOW, props)
            self.assertTrue(
                any(
                    "workspace browse" in arg
                    for arg in args
                    if arg.startswith("click_script=")
                )
            )


class SquareComponentTests(unittest.TestCase):
    def test_shortcut_badges_and_all_component_corners(self):
        with patch.object(
            w, "WORKSPACE_SHORTCUTS", {"1": "1", "browse": "4", "jobs": "7"}
        ):
            args, _ = w.plan(
                {"1": [], "browse": [], "jobs": [], "unbound": []},
                "browse",
                set(),
                1000,
            )
            props = sets(args)
            self.assertIn("icon=1", props[w.header("1")])
            self.assertIn("label.drawing=off", props[w.header("1")])
            self.assertIn("icon=7", props[w.header("jobs")])
            self.assertIn("label=jobs", props[w.header("jobs")])
            self.assertIn("icon.drawing=off", props[w.header("unbound")])
            self.assertIn("label=unbound", props[w.header("unbound")])
            self.assertTrue(
                all(arg.endswith("=0") for arg in args if "corner_radius=" in arg)
            )
        config = (SOURCE.parent.parent / "sketchybarrc").read_text()
        import re

        radii = re.findall(r"corner_radius=(\d+)", config)
        self.assertTrue(radii)
        self.assertEqual(set(radii), {"0"})


class NamedWorkspaceTests(unittest.TestCase):
    def test_named_headers_reserve_space_in_rendering_and_budget(self):
        groups = {"browse": [], "os finances": [], "warrior v2": []}
        args, *_ = w.plan(groups, "browse", set(), 1000)
        for name in groups:
            with self.subTest(workspace=name):
                start = args.index(w.header(name), args.index("--add"))
                end = (
                    args.index("--add", start) if "--add" in args[start:] else len(args)
                )
                widths = [arg for arg in args[start:end] if arg.startswith("width=")]
                self.assertEqual(int(widths[-1].split("=")[1]), w.header_width(name))
                self.assertGreater(w.header_width(name), w.HEADER_WIDTH)
        self.assertGreater(
            sum(w.group_width(apps, 0, name) for name, apps in groups.items()),
            len(groups) * (w.HEADER_WIDTH + w.GROUP_GAP),
        )


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

    def test_status_budget_fails_closed_at_notch(self):
        import display

        value = self.native()
        value["rightArea"] = [562, 450, 32]
        with self.assertRaises(ValueError):
            display.normalize(value)
        value["rightArea"] = [560, 452, 32]
        self.assertEqual(
            display.normalize(value)["width"] - display.normalize(value)["right"], 452
        )

    def test_display_recovery(self):
        with (
            patch.object(w, "geometry", side_effect=[ValueError(), [DISPLAY]]),
            patch.object(w, "save_topology"),
            patch.object(w, "save_viewports"),
            patch.object(w, "load_widths", return_value={}),
            patch.object(w, "load_viewports", return_value={}),
            patch.object(w, "save_widths"),
            patch.object(w, "lock", return_value=contextlib.nullcontext()),
            patch.object(w, "query", return_value={"items": ["apple"]}),
            patch.object(w, "load_widths", return_value={}),
            patch.object(w, "load_viewports", return_value={}),
            patch.object(w, "selection_args", return_value=[]),
            patch.object(w, "inventory", return_value=[(DISPLAY, {}, "")]),
            patch.object(w, "run") as run,
        ):
            w.render()
            self.assertIn("hidden=on", run.call_args.args[0])
            w.render()
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
    return w.membership(list(spaces), rows, focused)


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


class SelectionTests(unittest.TestCase):
    def names(self):
        return {
            w.item_id(kind, ws, display=display)
            for kind in ("space", "group")
            for ws, display in (("1", 1), ("browse", 1), ("jobs", 2))
        }

    def colors(self, args):
        return {
            name: dict(prop.split("=", 1) for prop in props)
            for name, props in sets(args).items()
        }

    def assert_selected(self, args, visible):
        colors = self.colors(args)
        for ws, display in (("1", 1), ("browse", 1), ("jobs", 2)):
            active = ws in visible
            badge = colors[w.header(ws, display)]
            group = colors[w.item_id("group", ws, display=display)]
            self.assertEqual(badge["icon.color"], w.YELLOW if active else w.TEXT)
            self.assertEqual(
                badge["icon.background.color"], "0x44eed49f" if active else "0x663d3d3d"
            )
            self.assertEqual(
                badge["icon.background.border_color"], w.YELLOW if active else w.SURFACE
            )
            self.assertEqual(
                group["background.color"], w.ACTIVE if active else w.INACTIVE
            )
            self.assertEqual(
                group["background.border_color"], w.YELLOW if active else w.SURFACE
            )

    def test_fast_path_live_ids_current_visibility_no_inventory_or_layout(self):
        names = self.names() | {"apple", "wsc.app.unrelated.d1", "space.1"}
        calls, held = [], set()
        real_lock = w.lock

        @contextlib.contextmanager
        def lock(name, wait=True):
            self.assertNotEqual(name, "render.lock")
            calls.append(name)
            with real_lock(name, wait) as fd:
                held.add(name)
                try:
                    yield fd
                finally:
                    held.remove(name)

        def query(args):
            self.assertIn("apply.lock", held)
            if args == ["sketchybar", "--query", "bar"]:
                return {"items": list(names)}
            self.assertEqual(
                args,
                [
                    w.AEROSPACE,
                    "list-workspaces",
                    "--monitor",
                    "all",
                    "--visible",
                    "--json",
                ],
            )
            return [{"workspace": "browse"}, {"workspace": "jobs"}]

        with (
            tempfile.TemporaryDirectory() as temp,
            patch.object(w.Path, "home", return_value=Path(temp)),
            patch.object(w, "lock", side_effect=lock),
            patch.object(w, "query", side_effect=query),
            patch.object(w, "geometry", side_effect=AssertionError("geometry")),
            patch.object(w, "inventory", side_effect=AssertionError("inventory")),
            patch.object(w, "render", side_effect=AssertionError("render")),
            patch.object(w, "run") as run,
            patch.dict(os.environ, {"FOCUSED_WORKSPACE": "1"}),
        ):
            w.select()
        args = run.call_args.args[0]
        self.assert_selected(args, {"browse", "jobs"})
        self.assertEqual(set(sets(args)), self.names())
        self.assertFalse(
            any(
                prop.startswith(("width=", "drawing=", "display=", "icon.width="))
                for prop in args
            )
        )
        self.assertEqual(calls.count("apply.lock"), 1)
        self.assertFalse(held)

    def test_cached_topology_removes_bar_query_and_never_persists_metadata(self):
        names = self.names()
        with (
            tempfile.TemporaryDirectory() as temp,
            patch.object(w.Path, "home", return_value=Path(temp)),
        ):
            w.save_topology(
                names
                | {
                    "private workspace",
                    "Private App",
                    "Private window title",
                    w.item_id("app", "1", "private.bundle", 1),
                }
            )
            self.assertEqual(w.load_topology(), names)
            raw = (
                Path(temp) / ".cache/sketchybar-workspaces/topology.lock"
            ).read_text()
            self.assertEqual(set(json.loads(raw)), names)
            self.assertNotIn("private", raw.lower())
            with (
                patch.object(
                    w,
                    "query",
                    return_value=[{"workspace": "browse"}, {"workspace": "jobs"}],
                ) as query,
                patch.object(w, "geometry", side_effect=AssertionError("geometry")),
                patch.object(w, "inventory", side_effect=AssertionError("inventory")),
                patch.object(w, "run") as run,
            ):
                w.select()
            query.assert_called_once_with(
                [
                    w.AEROSPACE,
                    "list-workspaces",
                    "--monitor",
                    "all",
                    "--visible",
                    "--json",
                ]
            )
            run.assert_called_once()
            self.assert_selected(run.call_args.args[0], {"browse", "jobs"})

    def test_invalid_topology_never_applies_unvalidated_ids_and_recovers(self):
        names = self.names()
        with (
            tempfile.TemporaryDirectory() as temp,
            patch.object(w.Path, "home", return_value=Path(temp)),
        ):
            for invalid in (
                b"partial[",
                b"null",
                b"{}",
                b'["Private app"]',
                b"[23]",
                b'"' + b"a" * 65536 + b'"',
            ):
                with w.lock("topology.lock") as fd:
                    os.write(fd, invalid)
                    os.ftruncate(fd, len(invalid))
                self.assertIsNone(w.load_topology())
                with (
                    patch.object(
                        w,
                        "query",
                        side_effect=[
                            {"items": list(names)},
                            [{"workspace": "browse"}, {"workspace": "jobs"}],
                        ],
                    ),
                    patch.object(w, "run") as run,
                ):
                    w.select()
                self.assert_selected(run.call_args.args[0], {"browse", "jobs"})
                self.assertEqual(w.load_topology(), names)
            w.invalidate()
            self.assertIsNone(w.load_topology())
            with (
                patch.object(
                    w,
                    "query",
                    side_effect=subprocess.CalledProcessError(1, "sketchybar"),
                ),
                patch.object(w, "run") as run,
                self.assertRaises(subprocess.CalledProcessError),
            ):
                w.select()
            run.assert_not_called()
            self.assertIsNone(w.load_topology())
        config = (SOURCE.parent.parent / "sketchybarrc").read_text()
        self.assertIn('python3 "$PLUGIN_DIR/workspaces.py" invalidate', config)

    def test_successful_structure_replaces_topology_after_removal_and_hotplug(self):
        first = [
            (DISPLAY, {"1": [], "browse": []}, "1"),
            ({**DISPLAY, "arrangement": 2}, {"jobs": []}, "jobs"),
        ]
        second = [({**DISPLAY, "arrangement": 3}, {"1": []}, "1")]
        with (
            tempfile.TemporaryDirectory() as temp,
            patch.object(w.Path, "home", return_value=Path(temp)),
            patch.object(w, "geometry", return_value=[DISPLAY]),
            patch.object(w, "inventory", side_effect=[first, second]),
            patch.object(
                w,
                "query",
                side_effect=lambda args: (
                    {"items": list(self.names())}
                    if args[-1] == "bar"
                    else {"geometry": {"width": 28}}
                    if args[0] == "sketchybar"
                    else [{"workspace": "1"}, {"workspace": "jobs"}]
                ),
            ),
            patch.object(w, "run") as run,
        ):
            w.render()
            self.assertEqual(w.load_topology(), self.names())
            w.render()
            expected = {w.header("1", 3), w.item_id("group", "1", display=3)}
            self.assertEqual(w.load_topology(), expected)
            self.assertTrue(all(name not in expected for name in self.names()))
            with patch.object(w, "query", return_value=[{"workspace": "1"}]) as query:
                w.select()
            self.assertEqual(
                set(sets(run.call_args.args[0])),
                expected
                | {
                    w.item_id("gap", "1", display=3),
                    w.item_id("entry", "1", display=3),
                    "wsc.overflow.d3",
                },
            )
            query.assert_called_once()

    def test_rapid_stale_callbacks_always_read_latest_and_clear_old_selection(self):
        current = {"1", "jobs"}

        def query(args):
            if args[0] == "sketchybar":
                return {"items": list(self.names())}
            return [{"workspace": ws} for ws in current]

        with (
            tempfile.TemporaryDirectory() as temp,
            patch.object(w.Path, "home", return_value=Path(temp)),
            patch.object(w, "query", side_effect=query),
            patch.object(w, "run") as run,
        ):
            for workspace in ["browse", "1"] * 10 + ["browse"]:
                current = {workspace, "jobs"}
                # Delayed callback payload deliberately claims the opposite.
                with patch.dict(
                    os.environ,
                    {"FOCUSED_WORKSPACE": "1" if workspace == "browse" else "browse"},
                ):
                    w.select()
                self.assert_selected(run.call_args.args[0], current)
            current = set()
            w.select()
            self.assert_selected(run.call_args.args[0], set())

    def test_notifications_coalesce_without_losing_changes_during_query_or_write(self):
        import concurrent.futures
        import threading

        for phase in ("query", "write"):
            with self.subTest(phase=phase):
                paused, resume = threading.Event(), threading.Event()
                current, writes, queries = {"1", "jobs"}, [], []

                def pause():
                    paused.set()
                    if not resume.wait(3):
                        raise AssertionError("notifications blocked behind selection")

                def query(args):
                    if args[0] == "sketchybar":
                        return {"items": list(self.names())}
                    snapshot = [{"workspace": ws} for ws in current]
                    queries.append(snapshot)
                    if phase == "query" and len(queries) == 1:
                        pause()
                    return snapshot

                def write(args):
                    writes.append(args)
                    if phase == "write" and len(writes) == 1:
                        pause()

                with (
                    tempfile.TemporaryDirectory() as temp,
                    patch.object(w.Path, "home", return_value=Path(temp)),
                    patch.object(w, "query", side_effect=query),
                    patch.object(w, "run", side_effect=write),
                    concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool,
                ):
                    owner = pool.submit(w.select)
                    self.assertTrue(paused.wait(3))
                    try:
                        current = {"browse", "jobs"}
                        # All duplicate callers return while the owner is still
                        # paused, rather than queueing 20 IPC query/apply passes.
                        callbacks = [pool.submit(w.select) for _ in range(20)]
                        for callback in callbacks:
                            callback.result(timeout=1)
                    finally:
                        resume.set()
                    owner.result(timeout=3)
                    self.assertEqual(len(queries), 2)
                    self.assertEqual(len(writes), 2)
                    self.assert_selected(writes[-1], current)
                    # A notification after worker handoff elects a new owner.
                    current = {"1", "jobs"}
                    w.select()
                    self.assert_selected(writes[-1], current)
                    self.assertEqual(len(writes), 3)

    def test_slow_structural_snapshot_cannot_revert_new_selection(self):
        import concurrent.futures
        import threading

        collecting, resume = threading.Event(), threading.Event()
        names = self.names()
        writes = []

        def inventory(_displays):
            collecting.set()
            if not resume.wait(3):
                raise AssertionError("focus lane blocked behind inventory")
            return [
                (DISPLAY, {"1": [], "browse": []}, "1"),
                ({**DISPLAY, "arrangement": 2}, {"jobs": []}, "jobs"),
            ]

        def query(args):
            if args[0] == "sketchybar":
                return (
                    {"items": list(names)}
                    if args[-1] == "bar"
                    else {"geometry": {"width": 28}}
                )
            return [{"workspace": "browse"}, {"workspace": "jobs"}]

        with (
            tempfile.TemporaryDirectory() as temp,
            patch.object(w.Path, "home", return_value=Path(temp)),
            patch.object(w, "query", side_effect=query),
            patch.object(w, "geometry", return_value=[DISPLAY]),
            patch.object(w, "inventory", side_effect=inventory),
            patch.object(w, "run", side_effect=lambda args: writes.append(args)),
            concurrent.futures.ThreadPoolExecutor() as pool,
        ):
            pending = pool.submit(w.render)
            self.assertTrue(collecting.wait(3))
            try:
                w.select()  # succeeds before the structural inventory resumes
                self.assert_selected(writes[-1], {"browse", "jobs"})
                w.render()  # duplicate full pass is dropped, not queued
            finally:
                resume.set()
            pending.result(timeout=3)
        self.assertEqual(len(writes), 2)
        self.assert_selected(writes[-1], {"browse", "jobs"})

    def test_native_callback_routes_to_independent_selection_item(self):
        config = (SOURCE.parent.parent / "sketchybarrc").read_text()
        self.assertIn(r'script="python3 \"$PLUGIN_DIR/workspaces.py\" select"', config)
        self.assertIn(
            "--subscribe workspace_selection aerospace_workspace_change front_app_switched",
            config,
        )
        self.assertNotIn(
            "--subscribe workspace_controller aerospace_workspace_change", config
        )
        with (
            patch.object(sys, "argv", ["workspaces.py", "select"]),
            patch.object(w, "select") as select,
            patch.object(w, "render", side_effect=AssertionError("full render")),
        ):
            self.assertEqual(w.main(), 0)
            select.assert_called_once()


class LatencyProbeTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location(
            "latency", Path(__file__).with_name("sketchybar-latency.py")
        )
        self.probe = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.probe)

    def test_odd_and_even_bursts_time_an_actual_final_switch(self):
        p = self.probe
        for count in (1, 2, 11, 12):
            with (
                self.subTest(count=count),
                patch.object(p, "switch") as switch,
                patch.object(p, "matches", return_value=True),
                patch.object(p.w, "query", return_value=[]),
                patch.object(p.time, "monotonic", side_effect=[0, 0.1, 0.2, 7]),
                patch("builtins.print"),
            ):
                p.burst_probe(count, "first", "second", {"arrangement": 1}, [], 250)
                targets = [call.args[0] for call in switch.call_args_list]
                self.assertEqual(len(targets), count + 1)
                self.assertNotEqual(targets[-1], targets[-2])

    def test_readiness_waits_for_missing_items_before_any_switch(self):
        p = self.probe
        states = [(DISPLAY, {"1": []}, "1")]
        names = [w.header("1", 1), w.item_id("group", "1", display=1)]
        with (
            patch.object(
                p,
                "query",
                side_effect=[
                    json.JSONDecodeError("reload", "", 0),
                    {"items": []},
                    {"items": names},
                ],
            ),
            patch.object(p, "matches", return_value=True),
            patch.object(
                p, "switch", side_effect=AssertionError("readiness changed workspace")
            ),
            patch.object(p.time, "sleep") as sleep,
        ):
            p.wait_ready(states)
        self.assertEqual(sleep.call_count, 2)

    def test_readiness_is_bounded(self):
        p = self.probe
        with (
            patch.object(p, "query", return_value={"items": []}),
            patch.object(p.time, "monotonic", side_effect=[0, 9]),
            self.assertRaisesRegex(AssertionError, "not ready before timing"),
        ):
            p.wait_ready([(DISPLAY, {"1": []}, "1")])


class AppIconTests(unittest.TestCase):
    def test_package_map_and_font(self):
        if "SKETCHYBAR_APP_FONT_MAP" not in os.environ:
            self.skipTest("Set package map/font paths or run the Nix check")
        mapping = w.load_icon_map()
        for name, glyph in {
            "Terminal": ":terminal:",
            "ChatGPT": ":openai:",
            "Zen": ":zen_browser:",
            "Discord": ":discord:",
            "Google Chrome": ":google_chrome:",
            "Default": ":default:",
            "UGREEN NAS": ":ugreen-nas:",
        }.items():
            self.assertEqual(mapping[name], glyph)
        font = Path(os.environ["SKETCHYBAR_APP_FONT_FILE"]).read_bytes()
        self.assertIn(font[:4], (b"\x00\x01\x00\x00", b"OTTO"))

    def test_terminal_aliases_bundle_overrides_and_logos(self):
        with patch.object(
            w, "ICON_MAP", {"Zen": ":zen_browser:", "Discord": ":discord:"}
        ):
            for name in w.TERMINAL_NAMES:
                self.assertEqual(
                    w.app_icon("unknown", name), (":terminal:", w.APP_FONT)
                )
            for bundle in w.TERMINAL_BUNDLES:
                self.assertEqual(w.app_icon(bundle, "Renamed")[0], ":terminal:")
            for bundle, name, glyph in (
                ("com.openai.chat", "Renamed", ":openai:"),
                ("unknown", "ChatGPT", ":openai:"),
                ("unknown", "OpenAI", ":openai:"),
                ("com.google.Chrome.for.Testing", "Renamed", ":google_chrome:"),
                ("unknown", "Google Chrome for Testing", ":google_chrome:"),
                ("unknown", "Zen", ":zen_browser:"),
                ("unknown", "Discord", ":discord:"),
                ("unknown", "Unmapped", ":default:"),
            ):
                self.assertEqual(w.app_icon(bundle, name), (glyph, w.APP_FONT))

    def test_unavailable_map_or_font_uses_nerd_font(self):
        with patch.dict(
            os.environ, {"SKETCHYBAR_APP_FONT_MAP": "/missing/icon_map.lua"}
        ):
            self.assertEqual(w.load_icon_map(), {})
        with patch.dict(os.environ, {"SKETCHYBAR_APP_FONT_FILE": "/missing/font.ttf"}):
            self.assertEqual(w.load_icon_map(), {})
        with patch.object(w, "ICON_MAP", {}):
            for name in ("WezTerm", "ChatGPT", "Unknown"):
                self.assertEqual(
                    w.app_icon("unknown", name), (w.FALLBACK_ICON, w.FALLBACK_FONT)
                )
                self.assertNotIn(":", w.app_icon("unknown", name)[0])

    def test_literal_map_is_data_not_code(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            (path / "font").touch()
            (path / "map").write_text(
                'os.execute("false")\n[ [[Safe]] ] = ":default:",\n[ [[Bad]] ] = ":bad:;command",\n'
            )
            with patch.dict(
                os.environ,
                {
                    "SKETCHYBAR_APP_FONT_MAP": str(path / "map"),
                    "SKETCHYBAR_APP_FONT_FILE": str(path / "font"),
                },
            ):
                self.assertEqual(w.load_icon_map(), {"Safe": ":default:"})

    def test_inline_popups_overflow_and_migration_clear_all_images(self):
        groups, _ = snapshot([window(bundle="com.openai.chat", name="ChatGPT")])
        for budget in (600, 80):
            first, _ = w.plan(groups, "1", {"apple"}, budget)
            existing = set(sets(first)) | {"apple"}
            args, icons = w.plan(groups, "1", existing, budget)
            props = sets(args)
            self.assertNotIn("--add", args)
            self.assertFalse(any("=app." in prop for prop in args))
            for name, (glyph, font) in icons.items():
                for prop in w.clear_images() + [
                    "icon=" + glyph,
                    "icon.font=" + font,
                    "icon.color=" + w.TEXT,
                ]:
                    self.assertIn(prop, props[name])


class MultiDisplayTests(unittest.TestCase):
    def test_native_failure_isolated_to_affected_panel_and_recovers(self):
        import display

        laptop = NativeGeometryTests().native()
        external = dict(laptop, arrangement=7, screen=1, top=0, origin=1800)
        invalid = dict(laptop, leftArea=[0, 0, 0])
        for native, expected in (
            ([invalid, external], [7]),
            ([laptop, external], [1, 7]),
        ):
            with patch.object(
                display.subprocess,
                "check_output",
                side_effect=["[]", json.dumps(native)],
            ):
                self.assertEqual(
                    [d["arrangement"] for d in display.geometry()], expected
                )
        too_narrow = dict(external, width=400)
        with self.assertRaises(ValueError):
            display.normalize(too_narrow)

    def test_inventory_independent_ids_empty_groups_and_visible_selection(self):
        external = dict(
            DISPLAY, arrangement=7, screen=1, left=960, right=960, width=1920
        )
        calls = []

        def query(args):
            calls.append(args)
            if "list-monitors" in args:
                return MONITORS
            if "list-windows" in args:
                return [window("1"), window("external", number=2)]
            monitor = args[args.index("--monitor") + 1]
            return [
                {"workspace": ws}
                for ws in (
                    ["1", "empty"] if monitor == "9" else ["external", "external-empty"]
                )
            ]

        def run(args):
            return "1" if args[args.index("--monitor") + 1] == "9" else "external"

        with (
            patch.object(w, "query", side_effect=query),
            patch.object(w, "run", side_effect=run),
        ):
            states = w.inventory([DISPLAY, external])
        self.assertEqual([visible for _, _, visible in states], ["1", "external"])
        self.assertEqual(list(states[0][1]), ["1", "empty"])
        self.assertEqual(list(states[1][1]), ["external", "external-empty"])
        self.assertEqual(sum("list-windows" in args for args in calls), 1)
        self.assertTrue(all("window-title" not in " ".join(args) for args in calls))
        args, _ = w.plan_all(states, {"apple", "clock"})
        props = sets(args)
        for panel, groups, visible in states:
            did = panel["arrangement"]
            for ws in groups:
                group = props[w.item_id("group", ws, display=did)]
                self.assertIn("display=" + str(did), group)
                self.assertIn(
                    "background.color=" + (w.ACTIVE if ws == visible else w.INACTIVE),
                    group,
                )
        self.assertEqual(args.count("--reorder"), 1)

    def test_unique_ids_per_panel_overflow_and_hotplug_cleanup(self):
        groups = {"same": [("org.test.App", "Test", 1)], "empty": []}
        external = dict(DISPLAY, arrangement=7, screen=1, left=100)
        states = [(DISPLAY, groups, "same"), (external, groups, "empty")]
        first, images = w.plan_all(states, {"apple"})
        props = sets(first)
        self.assertIn("wsc.overflow.d7", props)
        self.assertIn("drawing=off", props["wsc.overflow.d1"])
        for name in props:
            did = 7 if name.endswith(".d7") else 1
            self.assertIn("display=" + str(did), props[name])
        self.assertEqual(
            len(images), 5
        )  # two popups, two inline glyphs, narrow fallback app
        existing = set(props) | {"apple"}
        refresh, _ = w.plan_all(states, existing)
        self.assertNotIn("--add", refresh)
        self.assertNotIn("--remove", refresh)
        self.assertFalse(any(p.startswith("width=") for p in refresh))
        clamshell, _ = w.plan_all(states[1:], existing)
        removed = {clamshell[i + 1] for i, v in enumerate(clamshell) if v == "--remove"}
        self.assertEqual(removed, {name for name in props if name.endswith(".d1")})
        self.assertNotIn("apple", removed)
        # Reassigned IDs after a rearrangement update every association and remove
        # stale display-local groups rather than replicating them across screens.
        moved = dict(external, arrangement=3)
        rearranged, _ = w.plan_all([(moved, groups, "empty")], existing)
        self.assertIn("display=3", rearranged)
        self.assertNotIn("display=7", rearranged)
        self.assertTrue(all(name.endswith(".d3") for name in sets(rearranged)))

    def test_monitor_query_failure_does_not_suppress_other_panel(self):
        external = dict(DISPLAY, arrangement=7, screen=1)
        with (
            patch.object(w, "query", side_effect=[MONITORS, []]),
            patch.object(
                w, "snapshot", side_effect=[ValueError(), ({"empty": []}, "empty")]
            ),
        ):
            states = w.inventory([DISPLAY, external])
        self.assertEqual(states[0][1:], ({}, ""))
        self.assertEqual(states[1][1:], ({"empty": []}, "empty"))


class MembershipTests(unittest.TestCase):
    def test_query_contract_and_empty_workspaces(self):
        with (
            patch.object(
                w, "query", side_effect=[MONITORS, [], [{"workspace": "empty"}]]
            ) as query,
            patch.object(w, "run", return_value="2\n") as run,
        ):
            [(display, groups, focused)] = w.inventory([DISPLAY])
        self.assertEqual(list(groups), ["empty"])
        self.assertEqual(
            query.call_args_list[2].args[0],
            [w.AEROSPACE, "list-workspaces", "--monitor", "9", "--json"],
        )
        self.assertEqual(focused, "2")
        self.assertEqual(
            query.call_args_list[1].args[0],
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
            run.call_args.args[0],
            [w.AEROSPACE, "list-workspaces", "--monitor", "9", "--visible"],
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
        self.assertNotIn("icon.color=" + w.YELLOW, args)

    def test_no_displays_never_invents_workspaces(self):
        with patch.object(w, "query") as query:
            self.assertEqual(w.inventory([]), [])
        query.assert_not_called()

    def test_compact_popup_keeps_all_workspaces_and_monochrome_apps(self):
        groups, _ = snapshot([window()])
        args, images = w.plan(groups, "1", {"apple"}, 80)
        props = sets(args)
        self.assertIn("icon=▾", props["wsc.overflow"])
        for ws in groups:
            self.assertIn("drawing=off", props[w.header(ws)])
            self.assertIn("label=Workspace " + ws, props[w.item_id("entry", ws)])
        self.assertIn(
            "workspace_menus.py toggle wsc.overflow", " ".join(props["wsc.overflow"])
        )
        zero, _ = w.plan(groups, "1", {"apple"}, 0)
        self.assertNotIn("wsc.overflow", sets(zero))
        self.assertTrue(all("drawing=off" in sets(zero)[w.header(ws)] for ws in groups))

    def test_large_workspace_keeps_complete_right_click_inventory(self):
        groups = {"1": [(str(i), "App", i + 1) for i in range(50)], "2": []}
        args, _ = w.plan(groups, "1", set(), 300, 1)
        self.assertEqual(sum(n.startswith("wsc.popup.") for n in sets(args)), 50)

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
        self.assertIn("background.corner_radius=0", props[w.item_id("group", "1")])

    def test_new_app_item_rebuilds_bracket_before_removing_old_members(self):
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
            patch.object(w, "query", return_value={}),
            patch.object(w, "run", return_value="1"),
            self.assertRaises(ValueError),
        ):
            w.snapshot(DISPLAY, MONITORS, [])

    def test_safe_ids_and_shell_quoting(self):
        ws = "x'; touch /tmp/nope; #"
        bundle = "org.test.'; $bad"
        groups, _ = snapshot([window(ws, bundle, "Name ' $x")])
        args, _ = w.plan(groups, ws, {"apple"}, 600)
        for name in sets(args):
            self.assertRegex(
                name, r"^(space\.[1-7]|wsc\.overflow|wsc\.[a-z]+\.[a-f0-9]{24})$"
            )
        props = sets(args)[w.header(ws)]
        click = next(p.split("=", 1)[1] for p in props if p.startswith("click_script="))
        self.assertIn(shlex.quote(ws), click)
        # Exercise the shell parser with a fake AeroSpace function, not eval.
        click = click.replace(w.AEROSPACE, "capture").replace(
            w.menu_command("close"), ":"
        )
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
        self.assertIn(
            "click_script="
            + w.dismiss_before(w.command(w.AEROSPACE, "focus", "--window-id", 1)),
            app_props,
        )

    def test_monochrome_icons_geometry_selection(self):
        groups, _ = snapshot([window()])
        args, images = w.plan(groups, "1", {"apple"}, 600)
        props = sets(args)
        self.assertIn("background.color=" + w.ACTIVE, props[w.item_id("group", "1")])
        self.assertIn(
            "background.border_color=" + w.YELLOW, props[w.item_id("group", "1")]
        )
        self.assertIn("icon.color=" + w.YELLOW, props["space.1"])
        self.assertIn("background.color=" + w.INACTIVE, props[w.item_id("group", "2")])
        for name, (glyph, font) in images.items():
            self.assertIn("icon=" + glyph, props[name])
            self.assertIn("icon.font=" + font, props[name])
            self.assertIn("icon.color=" + w.TEXT, props[name])
            for prop in w.clear_images():
                self.assertIn(prop, props[name])
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
            "ram",
            "cpu",
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
        self.assertEqual(order[-5:], ["clock", "date", "battery", "ram", "cpu"])
        self.assertNotIn("unrelated", removals)

    def test_overflow_discloses_every_workspace_with_safe_click_targets(self):
        groups = {str(i): [] for i in range(8)}
        args, _ = w.plan(groups, "7", set(), 600, 1)
        props = sets(args)
        for ws in groups:
            entry = props[w.item_id("entry", ws, display=1)]
            self.assertIn(
                "click_script="
                + w.dismiss_before(w.command(w.AEROSPACE, "workspace", ws)),
                entry,
            )

    def test_display_budget_and_fallback(self):
        for left in (20, 300, 650, 900):
            self.assertEqual(
                w.inline_budget({**DISPLAY, "left": left}), max(0, left - 48)
            )

    def test_unavailable_preserves_membership_then_recovers(self):
        groups, _ = snapshot([window()])
        existing = {"apple", "space.1", w.item_id("app", "1", "org.test.App")}
        with (
            patch.object(w, "lock", return_value=contextlib.nullcontext()),
            patch.object(
                w,
                "query",
                side_effect=lambda args: (
                    {"items": list(existing)}
                    if args[-1] == "bar"
                    else {"geometry": {"width": 28}}
                ),
            ),
            patch.object(w, "save_topology"),
            patch.object(w, "geometry", return_value=[DISPLAY]),
            patch.object(w, "save_viewports"),
            patch.object(w, "load_widths", return_value={}),
            patch.object(w, "load_viewports", return_value={}),
            patch.object(w, "save_widths"),
            patch.object(w, "inventory", side_effect=ValueError),
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
            patch.object(
                w,
                "query",
                side_effect=lambda args: (
                    {"items": list(existing)}
                    if args[-1] == "bar"
                    else {"geometry": {"width": 28}}
                ),
            ),
            patch.object(w, "save_topology"),
            patch.object(w, "selection_args", return_value=[]),
            patch.object(w, "geometry", return_value=[DISPLAY]),
            patch.object(w, "inventory", return_value=[(DISPLAY, groups, "1")]),
            patch.object(w, "save_viewports"),
            patch.object(w, "load_widths", return_value={}),
            patch.object(w, "load_viewports", return_value={}),
            patch.object(w, "save_widths"),
            patch.object(w, "inline_budget", return_value=600),
            patch.object(w, "run") as run,
        ):
            w.render()
        self.assertIn("icon.color=" + w.YELLOW, run.call_args.args[0])

    def test_update_error_never_retries_native_images(self):
        groups, _ = snapshot([window()])
        with (
            patch.object(w, "lock", return_value=contextlib.nullcontext()),
            patch.object(w, "query", return_value={"items": ["apple"]}),
            patch.object(w, "load_widths", return_value={}),
            patch.object(w, "load_viewports", return_value={}),
            patch.object(w, "selection_args", return_value=[]),
            patch.object(w, "geometry", return_value=[DISPLAY]),
            patch.object(w, "inventory", return_value=[(DISPLAY, groups, "1")]),
            patch.object(
                w, "run", side_effect=subprocess.CalledProcessError(1, "sketchybar")
            ) as run,
            self.assertRaises(subprocess.CalledProcessError),
        ):
            w.render()
        run.assert_called_once()
        self.assertFalse(any("=app." in arg for arg in run.call_args.args[0]))

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

    def test_watch_focus_burst_selects_immediately_without_full_refresh(self):
        real_popen = subprocess.Popen
        children, handlers, triggers, selections = [], {}, [], []

        def spawn(args, **kwargs):
            child = real_popen(
                [
                    sys.executable,
                    "-c",
                    "import time; print("
                    + repr(
                        json.dumps(
                            {
                                "_event": "focused-workspace-changed",
                                "workspace": "window-detected",
                            }
                        )
                        + "\n"
                    )
                    + " * 40, flush=True); time.sleep(30)",
                ],
                **kwargs,
            )
            children.append(child)
            return child

        def select():
            selections.append(w.time.monotonic())
            handlers[signal.SIGTERM](signal.SIGTERM, None)

        with (
            patch.object(w, "lock", return_value=contextlib.nullcontext()),
            patch.object(
                w.signal,
                "signal",
                side_effect=lambda sig, handler: handlers.update({sig: handler}),
            ),
            patch.object(w.subprocess, "Popen", side_effect=spawn),
            patch.object(
                w, "trigger", side_effect=lambda: triggers.append(w.time.monotonic())
            ),
            patch.object(w, "select", side_effect=select),
        ):
            w.watch()
        self.assertEqual(len(selections), 1)
        self.assertEqual(len(triggers), 2)  # startup + disconnect, no focus render
        self.assertLess(selections[0] - triggers[0], 0.19)
        self.assertIsNotNone(children[0].poll())
        self.assertTrue(children[0].stdout.closed)

    def test_watch_real_child_debounces_and_reaps(self):
        real_popen = subprocess.Popen
        children, handlers, triggers = [], {}, []

        def spawn(args, **kwargs):
            self.assertEqual(args, [w.AEROSPACE, "subscribe", *w.EVENTS])
            child = real_popen(
                [
                    sys.executable,
                    "-c",
                    "import time; print("
                    + repr(json.dumps({"_event": "window-detected"}) + "\n")
                    + " * 40, flush=True); time.sleep(30)",
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
            patch.object(w, "select") as select,
        ):
            w.watch()
        self.assertEqual(len(children), 1)
        select.assert_called()
        self.assertEqual(len(triggers), 3)  # startup, coalesced burst, trailing refresh
        self.assertGreaterEqual(triggers[1] - triggers[0], 0.19)
        self.assertIsNotNone(children[0].poll())
        self.assertTrue(children[0].stdout.closed)


if __name__ == "__main__":
    unittest.main()
