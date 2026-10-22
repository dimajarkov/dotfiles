#!/usr/bin/env python3
"""Exercise shell plugins with isolated command fixtures, never the live desktop."""

import importlib.util
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
        if plugin == "display.sh":
            native = (
                (CONFIG / "plugins/display.py")
                .read_text()
                .replace("/usr/bin/osascript", str(self.directory / "osascript"))
            )
            plugins = self.directory / "plugins"
            plugins.mkdir(exist_ok=True)
            (plugins / "display.py").write_text(native)
            environment["CONFIG_DIR"] = str(self.directory)
        subprocess.run(
            ["/bin/bash", "-c", text],
            env={**self.environment, **environment},
            check=True,
            capture_output=True,
            text=True,
        )
        return [json.loads(line) for line in self.calls.read_text().splitlines()]

    def test_top_strip_config_reconciles_membership(self):
        subprocess.run(
            ["/bin/bash", str(CONFIG / "sketchybarrc")],
            env=self.environment,
            check=True,
            capture_output=True,
            text=True,
        )
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()]
        for prop in (
            "position=top",
            "height=32",
            "margin=0",
            "y_offset=0",
            "corner_radius=0",
            "topmost=window",
            "show_in_fullscreen=off",
        ):
            self.assertIn(prop, calls[0])
        self.assertIn("hidden=on", calls[0])
        controller = next(c for c in calls if "workspace_controller" in c)
        self.assertIn("update_freq=5", controller)
        self.assertIn("aerospace_state_change", controller)
        self.assertTrue(any("workspaces.py" in arg for arg in controller))

    def test_status_widths_and_actions(self):
        config = (CONFIG / "sketchybarrc").read_text()
        self.assertNotIn("volume", config)
        self.assertNotIn("volume", (CONFIG / "plugins/status.sh").read_text())
        for name, width in (
            ("clock", 60),
            ("date", 100),
            ("battery", 84),
            ("ram", 76),
            ("cpu", 76),
        ):
            self.assertIn(f"--set {name} width={width}", config)
        self.assertEqual(config.count('click_script="/usr/bin/open -a Calendar"'), 2)
        self.assertIn("--add bracket datetime date clock", config)
        self.assertIn("icon.drawing=on", config.split("--set battery", 1)[1])
        self.assertIn("update_freq=15", config)

    def test_shell_syntax(self):
        for path in [CONFIG / "sketchybarrc", *CONFIG.rglob("*.sh")]:
            with self.subTest(path=path):
                subprocess.run(["/bin/bash", "-n", str(path)], check=True)

    def test_clock(self):
        calls = self.run_plugin(NAME="clock")
        self.assertRegex(calls[0][-1], r"^label=\d{2}:\d{2}$")

    def test_date(self):
        calls = self.run_plugin(NAME="date")
        self.assertRegex(calls[0][-1], r"^label=\w{3} \d{2} \w{3}$")

    def test_display_selection_and_external_only(self):
        spec = importlib.util.spec_from_file_location(
            "native_display", CONFIG / "plugins/display.py"
        )
        display = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(display)
        laptop = {"arrangement": 2, "left": 600, "right": 800}
        external = {"arrangement": 1, "left": 960, "right": 960}
        self.assertEqual(
            display.bar_properties([external, laptop]),
            ["--bar", "display=1,2", "notch_width=200", "hidden=off"],
        )
        self.assertEqual(
            display.bar_properties([external]),
            ["--bar", "display=1", "notch_width=0", "hidden=off"],
        )
        self.assertEqual(display.bar_properties([]), ["--bar", "hidden=on"])


if __name__ == "__main__":
    unittest.main()
