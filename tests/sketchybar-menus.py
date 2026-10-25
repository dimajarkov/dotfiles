#!/usr/bin/env python3
"""Workspace menu lifecycle through generated scripts, never the live desktop."""

import importlib.util
import importlib
import contextlib
import threading
import json
import os
import shlex
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = (
    Path(__file__).resolve().parents[1]
    / "home/.config/sketchybar/plugins/workspaces.py"
)
spec = importlib.util.spec_from_file_location("workspace_menu_renderer", SOURCE)
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)
menus = importlib.import_module("workspace_menus")


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


class MenuScriptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / "bar.json"
        first, _ = w.plan({"1": [("org.app", "Example", 7)]}, "1", set(), 1000, 1)
        second, _ = w.plan({"2": []}, "2", set(), 1000, 2)
        self.props = {**properties(first), **properties(second)}
        self.hosts = [w.header("1", 1), w.header("2", 2)]
        self.state.write_text(
            json.dumps(
                {
                    name: {"popup": {"drawing": "off"}}
                    for name in [*self.hosts, "unrelated"]
                }
            )
        )
        fixture = self.root / "sketchybar"
        fixture.write_text(
            "#!"
            + sys.executable
            + "\n"
            + """
import fcntl, json, os, sys
from pathlib import Path
path = Path(os.environ['MENU_FIXTURE'])
with path.open('r+') as output:
    fcntl.flock(output, fcntl.LOCK_EX)
    state = json.load(output)
    args = sys.argv[1:]
    if args[:2] == ['--query', 'bar']:
        print(json.dumps({'items': list(state)}))
    elif args[:1] == ['--query']:
        print(json.dumps(state[args[1]]))
    else:
        name = None
        for i, arg in enumerate(args):
            if arg == '--set': name = args[i+1]
            if arg.startswith('popup.drawing='):
                value = arg.split('=',1)[1]
                current = state[name]['popup']['drawing']
                state[name]['popup']['drawing'] = ('off' if current == 'on' else 'on') if value == 'toggle' else value
        output.seek(0); json.dump(state, output); output.truncate()
"""
        )
        fixture.chmod(0o755)
        self.env = {
            **os.environ,
            "HOME": str(self.root),
            "PATH": str(self.root) + ":" + os.environ["PATH"],
            "MENU_FIXTURE": str(self.state),
            "BUTTON": "right",
        }

    def click(self, host, button="right"):
        script = next(
            p.split("=", 1)[1]
            for p in self.props[host]
            if p.startswith("click_script=")
        )
        script = script.replace(w.AEROSPACE, str(self.root / "action"))
        script = script.replace(
            shlex.join([sys.executable, str(SOURCE.with_name("workspace_labels.py"))]),
            str(self.root / "action"),
        )
        result = subprocess.run(
            ["/bin/sh", "-c", script],
            env={**self.env, "BUTTON": button},
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_opening_another_workspace_closes_previous_menu_across_displays(self):
        self.click(self.hosts[0])
        self.click(self.hosts[1])
        state = json.loads(self.state.read_text())
        self.assertEqual(
            [host for host in self.hosts if state[host]["popup"]["drawing"] == "on"],
            [self.hosts[1]],
        )
        self.assertEqual(state["unrelated"]["popup"]["drawing"], "off")

    def test_fallback_host_is_exclusive_and_same_host_toggles_closed(self):
        args, _ = w.plan({"1": [], "2": []}, "1", set(), 60, 1)
        self.props.update(properties(args))
        overflow = "wsc.overflow.d1"
        state = json.loads(self.state.read_text())
        state[overflow] = {"popup": {"drawing": "off"}}
        state["unrelated"]["popup"]["drawing"] = "on"
        self.state.write_text(json.dumps(state))
        self.click(self.hosts[0])
        self.click(overflow)
        state = json.loads(self.state.read_text())
        self.assertEqual(
            [
                name
                for name in [*self.hosts, overflow]
                if state[name]["popup"]["drawing"] == "on"
            ],
            [overflow],
        )
        self.click(overflow)
        state = json.loads(self.state.read_text())
        self.assertTrue(
            all(
                state[name]["popup"]["drawing"] == "off"
                for name in [*self.hosts, overflow]
            )
        )
        self.assertEqual(state["unrelated"]["popup"]["drawing"], "on")

    def test_two_actual_scripts_open_concurrently_under_one_cross_process_lock(self):
        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor() as pool:
            list(pool.map(self.click, self.hosts))
        state = json.loads(self.state.read_text())
        self.assertEqual(
            sum(state[name]["popup"]["drawing"] == "on" for name in self.hosts), 1
        )

    def test_selection_closes_every_owned_menu_before_action_runs(self):
        action = self.root / "action"
        action.write_text(
            "#!"
            + sys.executable
            + "\n"
            + r"""
import json, os, sys
from pathlib import Path
state = json.loads(Path(os.environ['MENU_FIXTURE']).read_text())
with Path(os.environ['MENU_ACTIONS']).open('a') as output:
    output.write(json.dumps({'args': sys.argv[1:], 'open': [name for name in state if name.startswith('wsc.') and state[name]['popup']['drawing'] == 'on']}) + '\n')
"""
        )
        action.chmod(0o755)
        records = self.root / "actions.jsonl"
        self.env["MENU_ACTIONS"] = str(records)
        groups = {"1": [("org.app", "Example", 7)], "2": []}
        full, _ = w.plan(groups, "1", set(), 1000, 1, aliases={"1": "Mail"})
        narrow, _ = w.plan(groups, "1", set(), 60, 1, aliases={"1": "Mail"})
        for args, targets in (
            (
                full,
                [
                    (w.header("1", 1), "left"),
                    (w.item_id("app", "1", "org.app", 1), "left"),
                    (w.item_id("popup", "1", "org.app", 1), "left"),
                    (w.item_id("rename", "1", display=1), "left"),
                    (w.item_id("reset", "1", display=1), "left"),
                ],
            ),
            (
                narrow,
                [
                    (w.item_id("entry", "1", display=1), "left"),
                    (w.item_id("entry", "1", "org.app", 1), "left"),
                    (w.item_id("renameentry", "1", display=1), "left"),
                    (w.item_id("resetentry", "1", display=1), "left"),
                ],
            ),
        ):
            self.props.update(properties(args))
            for target, button in targets:
                with self.subTest(target=target):
                    state = json.loads(self.state.read_text())
                    for name in self.hosts:
                        state[name]["popup"]["drawing"] = "off"
                    state["wsc.overflow.d1"] = {"popup": {"drawing": "off"}}
                    state["unrelated"]["popup"]["drawing"] = "on"
                    self.state.write_text(json.dumps(state))
                    self.click(self.hosts[0])
                    self.click(target, button)
                    record = json.loads(records.read_text().splitlines()[-1])
                    self.assertEqual(
                        record["open"], [], "Menu must close before starting selection"
                    )
                    self.assertIn(
                        record["args"][0], {"workspace", "focus", "rename", "reset"}
                    )
                    self.assertEqual(
                        json.loads(self.state.read_text())["unrelated"]["popup"][
                            "drawing"
                        ],
                        "on",
                    )

    def test_hosts_subscribe_to_native_exit_routing_without_losing_scroll_dispatch(
        self,
    ):
        manifest = {}
        args, _ = w.plan(
            {str(i): [] for i in range(1, 8)}, "1", set(), 160, 1, manifest
        )
        props = properties(args)
        host = w.header("1", 1)
        self.assertIn("mouse.exited", args)
        self.assertIn("mouse.exited.global", args)
        script = next(p[7:] for p in props[host] if p.startswith("script="))
        self.assertIn(" event 1", script)
        self.assertIn("mouse.scrolled", args)
        manifest["1"]["screen"] = 1
        with patch.object(w.Path, "home", return_value=self.root):
            w.save_viewports(manifest)
        state = json.loads(self.state.read_text())
        state.update(
            {w.header(str(i), 1): {"popup": {"drawing": "off"}} for i in range(1, 8)}
        )
        self.state.write_text(json.dumps(state))
        subprocess.run(
            ["/bin/sh", "-c", script],
            env={
                **self.env,
                "SENDER": "mouse.scrolled",
                "SCROLL_DELTA": "-2",
                "SCROLL_DELTA_X": "0",
                "NAME": host,
            },
            check=True,
            capture_output=True,
            text=True,
        )
        with patch.object(w.Path, "home", return_value=self.root):
            self.assertEqual(w.load_viewports()["1"]["start"], 2)


class MenuExitTests(unittest.TestCase):
    def setUp(self):
        self.first = w.header("1", 1)
        self.second = w.header("2", 2)
        self.row1 = w.item_id("popup", "1", "app", 1)
        self.row2 = w.item_id("rename", "1", display=1)

        def rect(x, y, width, height):
            return {"display-1": {"origin": [x, y], "size": [width, height]}}

        self.state = {
            self.first: {
                "geometry": {"drawing": "on"},
                "bounding_rects": rect(0, 0, 28, 32),
                "popup": {
                    "drawing": "off",
                    "background": {"border_width": 1},
                    "items": [self.row1, self.row2],
                },
            },
            self.second: {
                "geometry": {"drawing": "on"},
                "bounding_rects": {
                    "display-2": {"origin": [500, -1000], "size": [28, 32]}
                },
                "popup": {
                    "drawing": "off",
                    "background": {"border_width": 1},
                    "items": [],
                },
            },
            self.row1: {
                "geometry": {
                    "drawing": "on",
                    "background": {"padding_left": 0, "padding_right": 0},
                },
                "bounding_rects": rect(0, 33, 100, 24),
            },
            self.row2: {
                "geometry": {
                    "drawing": "on",
                    "background": {"padding_left": 0, "padding_right": 0},
                },
                "bounding_rects": rect(0, 57, 60, 24),
            },
            "unrelated": {"popup": {"drawing": "on"}},
        }
        self.calls = []
        self.mutex = threading.Lock()
        self.point = (0, 0)

        @contextlib.contextmanager
        def guard(_name):
            with self.mutex:
                yield

        self.controller = menus.Menus(
            execute=self.execute, guard=guard, position=lambda: self.point
        )

    def execute(self, args):
        self.calls.append(args)
        if args[1] == "--query":
            return "\n".join(
                json.dumps(
                    {"items": list(self.state)}
                    if args[i + 1] == "bar"
                    else self.state[args[i + 1]]
                )
                for i in range(1, len(args), 2)
            )
        for i, arg in enumerate(args):
            if arg == "--set":
                self.state[args[i + 1]]["popup"]["drawing"] = args[i + 2].split("=", 1)[
                    1
                ]
        return ""

    def test_host_dropdown_and_border_keep_open_but_leaving_region_closes(self):
        self.controller.toggle(self.first)
        for point in ((10, 10), (10, 32), (95, 70), (100.5, 81.5)):
            with self.subTest(point=point):
                self.point = point
                self.controller.exit(self.first)
                self.assertEqual(self.state[self.first]["popup"]["drawing"], "on")
        self.point = (120, 90)
        self.controller.exit(self.first)
        self.assertEqual(self.state[self.first]["popup"]["drawing"], "off")
        self.assertEqual(self.state["unrelated"]["popup"]["drawing"], "on")

    def test_delayed_global_notifications_cannot_close_new_menu_under_pointer(self):
        self.controller.toggle(self.first)
        self.controller.toggle(self.second)
        self.point = (510, -990)
        self.controller.exit(self.first)
        self.controller.exit(self.second)
        self.assertEqual(self.state[self.second]["popup"]["drawing"], "on")
        self.controller.toggle(self.second)
        self.controller.toggle(self.first)
        self.point = (95, 70)
        self.controller.exit(self.first)
        self.assertEqual(self.state[self.first]["popup"]["drawing"], "on")

    def test_event_dispatch_obeys_native_host_popup_transition_and_global_exit(self):
        self.controller.toggle(self.first)
        self.point = (95, 70)
        with patch.dict(os.environ, {"SENDER": "mouse.exited", "NAME": self.first}):
            w.event(1, self.controller)
        self.assertEqual(self.state[self.first]["popup"]["drawing"], "on")
        self.point = (120, 90)
        with patch.dict(
            os.environ, {"SENDER": "mouse.exited.global", "NAME": self.first}
        ):
            w.event(1, self.controller)
        self.assertEqual(self.state[self.first]["popup"]["drawing"], "off")

    def test_concurrent_opens_are_serialized_and_unrelated_popup_is_untouched(self):
        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor() as pool:
            list(pool.map(self.controller.toggle, [self.first, self.second] * 5))
        self.assertLessEqual(
            sum(
                self.state[name]["popup"]["drawing"] == "on"
                for name in (self.first, self.second)
            ),
            1,
        )
        self.assertEqual(self.state["unrelated"]["popup"]["drawing"], "on")


if __name__ == "__main__":
    unittest.main()
