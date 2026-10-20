#!/usr/bin/env python3
"""Exercise shell plugins with isolated command fixtures, never the live desktop."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "home/.config/sketchybar"


class Plugins(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.calls = self.directory / "calls.jsonl"
        self.environment = {
            **os.environ,
            "PATH": f"{self.directory}:/usr/bin:/bin",
            "CONFIG_DIR": str(CONFIG),
            "CALLS": str(self.calls),
            "NAME": "",
            "SENDER": "",
            "INFO": "",
            "FOCUSED_WORKSPACE": "",
        }
        fixture = self.directory / "fixture"
        fixture.write_text(
            f"#!{os.sys.executable}\n"
            "import json, os, sys\n"
            "from pathlib import Path\n"
            "name = Path(sys.argv[0]).name\n"
            "if name == 'sketchybar':\n"
            "    with open(os.environ['CALLS'], 'a') as output:\n"
            "        output.write(json.dumps(sys.argv[1:]) + '\\n')\n"
            "    if sys.argv[1:] == ['--query', 'displays']:\n"
            "        print(os.environ.get('SKETCHYBAR_OUTPUT', '[]'))\n"
            "else:\n"
            "    print(os.environ.get(name.upper() + '_OUTPUT', ''))\n"
            "    sys.exit(int(os.environ.get(name.upper() + '_EXIT', '0')))\n"
        )
        fixture.chmod(0o755)
        for name in ("sketchybar", "aerospace", "pmset", "osascript"):
            (self.directory / name).symlink_to(fixture)

    def run_plugin(self, plugin="status.sh", **environment):
        # Substitute fixed native executable paths only in the disposable test copy.
        text = (CONFIG / "plugins" / plugin).read_text()
        for name, prefix in (
            ("aerospace", "/opt/homebrew/bin"),
            ("pmset", "/usr/bin"),
            ("osascript", "/usr/bin"),
        ):
            text = text.replace(f"{prefix}/{name}", str(self.directory / name))
        subprocess.run(
            ["/bin/bash", "-c", text],
            env={**self.environment, **environment},
            check=True,
            capture_output=True,
            text=True,
        )
        return [json.loads(line) for line in self.calls.read_text().splitlines()]

    def test_rail_config_is_thin_and_reconciles_membership(self):
        subprocess.run(
            ["/bin/bash", str(CONFIG / "sketchybarrc")],
            env=self.environment,
            check=True,
            capture_output=True,
            text=True,
        )
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()]
        self.assertIn("position=right", calls[0])
        self.assertIn("height=40", calls[0])
        self.assertIn("hidden=on", calls[0])
        controller = next(c for c in calls if "workspace_controller" in c)
        self.assertIn("update_freq=5", controller)
        self.assertIn("aerospace_state_change", controller)
        self.assertTrue(any("workspaces.py" in arg for arg in controller))

    def test_charged_battery(self):
        calls = self.run_plugin(
            NAME="battery",
            PMSET_OUTPUT="Now drawing from 'AC Power'\n -InternalBattery-0 (id=123)\t100%; charged; 0:00 remaining present: true",
        )
        self.assertIn("label=100%", calls[0])
        self.assertIn("icon.color=0xffa6da95", calls[0])

    def test_low_battery(self):
        calls = self.run_plugin(
            NAME="battery",
            PMSET_OUTPUT="Now drawing from 'Battery Power'\n -InternalBattery-0 (id=123)\t9%; discharging; 0:30 remaining present: true",
        )
        self.assertIn("label=9%", calls[0])
        self.assertIn("icon.color=0xffed8796", calls[0])

    def test_no_battery_hides_item(self):
        calls = self.run_plugin(
            NAME="battery", PMSET_OUTPUT="Now drawing from 'AC Power'"
        )
        self.assertEqual(calls[0], ["--set", "battery", "drawing=off"])

    def test_volume_event_decimal(self):
        calls = self.run_plugin(NAME="volume", SENDER="volume_change", INFO="42.5")
        self.assertIn("label=42%", calls[0])

    def test_volume_zero(self):
        calls = self.run_plugin(NAME="volume", SENDER="volume_change", INFO="0")
        self.assertIn("icon=", calls[0])
        self.assertIn("label=0%", calls[0])

    def test_volume_query_failure(self):
        calls = self.run_plugin(NAME="volume", OSASCRIPT_EXIT="1")
        self.assertIn("label=--", calls[0])

    def test_shell_syntax(self):
        for path in [CONFIG / "sketchybarrc", *CONFIG.rglob("*.sh")]:
            with self.subTest(path=path):
                subprocess.run(["/bin/bash", "-n", str(path)], check=True)

    def test_clock(self):
        calls = self.run_plugin(NAME="clock")
        self.assertRegex(calls[0][-1], r"^label=\d{2}:\d{2}$")

    def test_date(self):
        calls = self.run_plugin(NAME="date")
        self.assertRegex(calls[0][-1], r"^label=\d{2} \w{3}$")

    def test_display_selects_detected_builtin_not_fixed_index(self):
        calls = self.run_plugin("display.sh", OSASCRIPT_OUTPUT="2")
        self.assertEqual(calls[-1], ["--bar", "display=2", "hidden=off"])

    def test_clamshell_hides_bar(self):
        calls = self.run_plugin("display.sh")
        self.assertEqual(calls[-1], ["--bar", "hidden=on"])

    def test_display_detection_failure_hides_bar(self):
        calls = self.run_plugin("display.sh", OSASCRIPT_EXIT="1")
        self.assertEqual(calls[-1], ["--bar", "hidden=on"])

    def test_invalid_display_result_hides_bar(self):
        calls = self.run_plugin("display.sh", OSASCRIPT_OUTPUT="1,2")
        self.assertEqual(calls[-1], ["--bar", "hidden=on"])


if __name__ == "__main__":
    unittest.main()
