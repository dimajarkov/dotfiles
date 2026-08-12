import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).parents[1] / "scripts" / "feature_runtime.py"
SPEC = importlib.util.spec_from_file_location("feature_runtime", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FeatureRuntimeTests(unittest.TestCase):
    def test_accepts_exact_durable_lease(self):
        with tempfile.TemporaryDirectory() as directory:
            checkout = Path(directory) / "checkout"
            checkout.mkdir()
            result = MODULE.select_durable_lease(
                [{
                    "path": str(checkout),
                    "status": "leased",
                    "lease_id": "lease-id",
                    "lease_holder": "project/feature",
                    "leased_at": "2026-01-01T00:00:00Z",
                }],
                str(checkout),
            )
            self.assertEqual(result["lease_id"], "lease-id")
            self.assertEqual(result["lease_holder"], "project/feature")

    def test_rejects_process_only_in_use(self):
        with tempfile.TemporaryDirectory() as directory:
            checkout = Path(directory) / "checkout"
            checkout.mkdir()
            with self.assertRaisesRegex(MODULE.WorkflowError, "process-only in-use"):
                MODULE.select_durable_lease(
                    [{"path": str(checkout), "status": "in-use", "lease_id": "", "lease_holder": ""}],
                    str(checkout),
                )

    def test_rejects_ambiguous_treehouse_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            checkout = Path(directory) / "checkout"
            checkout.mkdir()
            row = {"path": str(checkout), "status": "leased", "lease_id": "x", "lease_holder": "y"}
            with self.assertRaisesRegex(MODULE.WorkflowError, "found 2"):
                MODULE.select_durable_lease([row, row], str(checkout))

    def test_command_json_is_argv_and_shell_quoted(self):
        command = MODULE.parse_command_json(
            json.dumps(["bun", "run", "dev", "value; touch /tmp/should-not-run"]),
            "runtime",
        )
        rendered = MODULE.shell_command(command)
        self.assertIn("'value; touch /tmp/should-not-run'", rendered)

    def test_topology_requires_one_feature_agent_and_at_most_one_runtime(self):
        feature = {"label": "feature-agent", "tab_id": "w1:t1"}
        runtime = {"label": "runtime", "tab_id": "w1:t2"}
        selected = MODULE.validate_tabs([feature, runtime], "w1")
        self.assertEqual(selected, (feature, runtime))
        with self.assertRaisesRegex(MODULE.WorkflowError, "conflicting runtime tabs"):
            MODULE.validate_tabs([feature, runtime, {**runtime, "tab_id": "w1:t3"}], "w1")

    def test_similar_labels_do_not_count_as_runtime(self):
        feature = {"label": "feature-agent", "tab_id": "w1:t1"}
        selected = MODULE.validate_tabs(
            [feature, {"label": "runtime-old", "tab_id": "w1:t2"}],
            "w1",
        )
        self.assertEqual(selected, (feature, None))


if __name__ == "__main__":
    unittest.main()
