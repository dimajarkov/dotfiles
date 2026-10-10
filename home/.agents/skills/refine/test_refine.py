from __future__ import annotations

import asyncio
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import refine


class RefineSkillTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.request = Path(self.temporary.name) / "nested" / "request.json"
        self.environment = patch.dict(os.environ, {"PI_REFINEMENT_REQUEST_FILE": str(self.request)})
        self.environment.start()

    def tearDown(self) -> None:
        self.environment.stop()
        self.temporary.cleanup()

    def test_run_queues_session_local_request_atomically(self) -> None:
        result = asyncio.run(refine.run("Keep the focused test"))
        self.assertEqual(result, {"scheduled": True})
        self.assertEqual(
            json.loads(self.request.read_text(encoding="utf-8")),
            {"pending": True, "instructions": "Keep the focused test", "global": False},
        )
        self.assertEqual(stat.S_IMODE(self.request.stat().st_mode), 0o600)
        self.assertEqual(list(self.request.parent.glob(f".{self.request.name}.*")), [])

    def test_run_preserves_explicit_global_scope(self) -> None:
        asyncio.run(refine.run("Durable cross-session lesson", global_=True))
        self.assertTrue(json.loads(self.request.read_text(encoding="utf-8"))["global"])

    def test_status_reports_the_queued_request(self) -> None:
        asyncio.run(refine.run())
        status = asyncio.run(refine.status())
        self.assertTrue(status["pending"])
        self.assertIsNone(status["request"]["instructions"])

    def test_invalid_arguments_do_not_write(self) -> None:
        with self.assertRaises(TypeError):
            asyncio.run(refine.run(1))  # type: ignore[arg-type]
        with self.assertRaises(TypeError):
            asyncio.run(refine.run(global_="yes"))  # type: ignore[arg-type]
        self.assertFalse(self.request.exists())

    def test_missing_host_environment_fails_clearly(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "only inside a Pi IPython session"):
                asyncio.run(refine.run())


if __name__ == "__main__":
    unittest.main()
