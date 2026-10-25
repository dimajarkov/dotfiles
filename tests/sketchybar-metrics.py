#!/usr/bin/env python3
"""Synthetic macOS telemetry samples; never query or modify the live bar."""

import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

SOURCE = (
    Path(__file__).resolve().parents[1] / "home/.config/sketchybar/plugins/metrics.py"
)
spec = importlib.util.spec_from_file_location("metrics", SOURCE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def vm(page_size=16384):
    return f"""Mach Virtual Memory Statistics: (page size of {page_size} bytes)
Pages free:                               150.
Pages active:                             200.
Pages inactive:                           300.
Pages speculative:                         25.
Pages wired down:                         100.
Pages purgeable:                           50.
Pages stored in compressor:               400.
Pages occupied by compressor:              50.
File-backed pages:                        200.
"""


class Metrics(unittest.TestCase):
    def test_cpu_aggregate_not_per_process(self):
        self.assertEqual(m.cpu_percent((100, 100, 100, 0), (200, 150, 250, 0)), 50)
        self.assertEqual(m.cpu_percent((0, 0, 0, 0), (800, 800, 0, 0)), 100)
        self.assertEqual(m.cpu_percent((0, 0, 0, 0), (0, 0, 1600, 0)), 0)

    def test_cpu_wrap_and_zero_sample(self):
        self.assertEqual(m.cpu_percent((2**32 - 10, 0, 0, 0), (10, 0, 20, 0)), 50)
        with self.assertRaises(ValueError):
            m.cpu_percent((1, 2, 3, 4), (1, 2, 3, 4))

    def test_ram_physical_not_logical_compressed_or_cached(self):
        for size in (4096, 16384):
            self.assertEqual(m.ram_percent(vm(size), size * 1000), 35)

    def test_malformed_ram_and_percentages(self):
        for sample, physical in (
            ("", 1000),
            (vm(), 0),
            (vm(), 1),
            (vm(0), 1000),
            (vm().replace("Pages active:", "Unknown:"), 10**9),
        ):
            with self.subTest(sample=sample), self.assertRaises(ValueError):
                m.ram_percent(sample, physical)
        for value in (float("nan"), float("inf"), -1, 101):
            with self.assertRaises(ValueError):
                m.percentage(value)

    def test_metric_colors_follow_cpu_load_and_native_memory_pressure(self):
        for busy, color in (
            (0, "0xffa6da95"),
            (69, "0xffa6da95"),
            (70, "0xffeed49f"),
            (89, "0xffeed49f"),
            (90, "0xffed8796"),
            (100, "0xffed8796"),
        ):
            for pressure, ram_color in (
                ("1", "0xffa6da95"),
                ("2", "0xffeed49f"),
                ("4", "0xffed8796"),
                ("99", m.TEXT),
                ("invalid", m.TEXT),
            ):

                def native(args):
                    if args == ["/usr/bin/vm_stat"]:
                        return vm()
                    if args[-1] == "hw.memsize":
                        return str(16384 * 1000)
                    if args[-1] == "kern.memorystatus_vm_pressure_level":
                        return pressure
                    raise AssertionError(args)

                with (
                    self.subTest(busy=busy, pressure=pressure),
                    patch.object(
                        m,
                        "cpu_ticks",
                        side_effect=[(0, 0, 0, 0), (busy, 0, 100 - busy, 0)],
                    ),
                    patch.object(m.time, "sleep"),
                    patch.object(m, "run", side_effect=native),
                    patch.object(m.subprocess, "run") as output,
                ):
                    m.main("metrics")
                    args = output.call_args.args[0]
                    split = args.index("ram")
                    self.assertIn("label.color=" + color, args[:split])
                    self.assertIn("label.color=" + ram_color, args[split:])
                    self.assertIn("label=35%", args[split:])

    def test_pressure_failure_preserves_ram_reading_and_resets_color(self):
        with (
            patch.object(m, "cpu_ticks", side_effect=OSError()),
            patch.object(m, "run", side_effect=[vm(), str(16384 * 1000), OSError()]),
            patch.object(m.subprocess, "run") as output,
        ):
            m.main("metrics")
            args = output.call_args.args[0]
            self.assertIn("label=35%", args)
            self.assertEqual(args.count("label.color=" + m.TEXT), 2)

    def test_battery_charge_discharge_full_and_missing(self):
        for value, state, bolt in (
            (9, "discharging", False),
            (50, "charging", True),
            (100, "charged", False),
        ):
            props = m.battery_properties(
                f"Now drawing from 'AC Power'\n -InternalBattery-0 (id=123)\t{value}%; {state};"
            )
            self.assertIn("drawing=on", props)
            self.assertIn(f"label={value}%", props)
            self.assertEqual(any("" in p for p in props), bolt)
            self.assertTrue(
                any(
                    p.startswith("icon=")
                    or p.startswith("icon=")
                    or p.startswith("icon=")
                    for p in props
                )
            )
        self.assertEqual(
            m.battery_properties("Now drawing from 'AC Power'"), ["drawing=off"]
        )
        self.assertIn("label=--", m.battery_properties("InternalBattery-0 999%;"))
        self.assertIn(
            "label=--", m.battery_properties("InternalBattery-0 (unavailable)")
        )

    def test_metrics_unavailable_and_partial_failure(self):
        for error in (
            OSError(),
            subprocess.TimeoutExpired("vm_stat", 3),
            subprocess.CalledProcessError(1, "vm_stat"),
            ValueError(),
        ):
            with (
                patch.object(m, "cpu_ticks", side_effect=OSError()),
                patch.object(m, "run", side_effect=error),
                patch.object(m.subprocess, "run") as output,
            ):
                m.main("metrics")
                self.assertEqual(
                    output.call_args.args[0],
                    [
                        "sketchybar",
                        "--set",
                        "cpu",
                        "label=--",
                        "label.color=" + m.TEXT,
                        "--set",
                        "ram",
                        "label=--",
                        "label.color=" + m.TEXT,
                    ],
                )
        with (
            patch.object(m, "cpu_ticks", side_effect=[(0, 0, 0, 0), (10, 10, 80, 0)]),
            patch.object(m.time, "sleep"),
            patch.object(m, "run", side_effect=ValueError()),
            patch.object(m.subprocess, "run") as output,
        ):
            m.main("metrics")
            self.assertIn("label=20%", output.call_args.args[0])
            self.assertIn("label=--", output.call_args.args[0])

    def test_battery_failure_and_command_timeout(self):
        with (
            patch.object(m, "run", side_effect=subprocess.TimeoutExpired("pmset", 3)),
            patch.object(m.subprocess, "run") as output,
        ):
            m.main("battery")
            self.assertIn("label=--", output.call_args.args[0])
            self.assertEqual(output.call_args.kwargs["timeout"], 3)
        with patch.object(m.subprocess, "check_output", return_value="ok") as command:
            self.assertEqual(m.run(["/usr/bin/vm_stat"]), "ok")
            self.assertEqual(command.call_args.kwargs["timeout"], 3)


if __name__ == "__main__":
    unittest.main()
