#!/usr/bin/env python3
"""Offline smoke tests for the pinned OMP binary and dotfiles configuration."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


BINARY = shutil.which(os.environ.get("OMP_BINARY", "omp"))
CONFIG = Path(__file__).resolve().parents[1] / "home/.omp/agent/config.yml"


class OhMyPiTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(BINARY, "Set OMP_BINARY or install omp first")
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.agent = self.root / "agent"
        self.agent.mkdir()
        self.target = self.root / "dotfiles-config.yml"
        shutil.copyfile(CONFIG, self.target)
        self.link = self.agent / "config.yml"
        self.link.symlink_to(self.target)
        self.environment = {
            **os.environ,
            "HOME": str(self.root),
            "PI_CODING_AGENT_DIR": str(self.agent),
            "OMP_PROFILE": "default",
        }
        self.environment.pop("PI_CONFIG_FILES", None)

    def run_omp(self, *arguments):
        return subprocess.run(
            [BINARY, *arguments],
            cwd=self.root,
            env=self.environment,
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        ).stdout

    def test_binary_starts(self):
        self.assertEqual(self.run_omp("--version").strip(), "omp/18.22.0")
        self.assertIn("USAGE", self.run_omp("--help"))

    def test_declared_settings_are_effective(self):
        settings = json.loads(self.run_omp("config", "list", "--json"))
        expected = {
            "modelRoles": {"default": "openai-codex/gpt-6.1-sol"},
            "modelRoleStorage": "global",
            "defaultThinkingLevel": "medium",
            "enabledModels": ["openai-codex/*"],
            "hideThinkingBlock": True,
            "steeringMode": "all",
            "followUpMode": "all",
            "startup.quiet": True,
            "startup.checkUpdate": False,
            "startup.changelogMode": "hidden",
            "update.auto": False,
            "skills.enableAgentsUser": True,
            "skills.enableAgentsProject": True,
            "theme.dark": "titanium",
            "theme.light": "light",
        }
        for key, value in expected.items():
            with self.subTest(key=key):
                self.assertEqual(settings[key]["value"], value)

    def test_runtime_settings_preserve_dotfiles_symlink(self):
        before = self.target.read_text()
        self.run_omp("config", "set", "defaultThinkingLevel", "low")
        self.assertTrue(self.link.is_symlink())
        self.assertEqual(self.link.resolve(), self.target.resolve())
        self.assertNotEqual(self.target.read_text(), before)
        result = json.loads(
            self.run_omp("config", "get", "defaultThinkingLevel", "--json")
        )
        self.assertEqual(result["value"], "low")


if __name__ == "__main__":
    unittest.main()
