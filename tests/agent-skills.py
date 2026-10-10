#!/usr/bin/env python3
"""Behavioral tests for the agent-skills migration command."""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
MIGRATOR = REPOSITORY_ROOT / "nix" / "migrate-agent-skills.py"


class AgentSkillsMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name)
        self.canonical = self.root / "dotfiles" / "home" / ".agents" / "skills"
        self.live = self.root / "home" / ".agents" / "skills"
        self.canonical.mkdir(parents=True)
        self.live.parent.mkdir(parents=True)
        self.live.mkdir()

    def run_migration(
        self, *, dry_run: bool = False
    ) -> subprocess.CompletedProcess[str]:
        command = [sys.executable, str(MIGRATOR), str(self.live), str(self.canonical)]
        if dry_run:
            command.append("--dry-run")
        return subprocess.run(command, capture_output=True, check=False, text=True)

    def run_migration_with_link_failure(
        self, *, concurrent_path: bool = False
    ) -> subprocess.CompletedProcess[str]:
        runner = f"""
import importlib.util
import pathlib
import sys
spec = importlib.util.spec_from_file_location("migrator", {str(MIGRATOR)!r})
migrator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migrator)
def fail_link(target, link):
    if {concurrent_path!r}:
        path = pathlib.Path(link)
        path.mkdir()
        (path / "concurrent.txt").write_text("preserve concurrent data")
    raise PermissionError("injected link failure")
migrator.os.symlink = fail_link
sys.exit(migrator.main(sys.argv[1:]))
"""
        return subprocess.run(
            [sys.executable, "-c", runner, str(self.live), str(self.canonical)],
            capture_output=True,
            check=False,
            text=True,
        )

    def write_file(
        self,
        root: Path,
        relative_path: str,
        contents: bytes,
        mode: int = 0o644,
    ) -> Path:
        path = root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(contents)
        path.chmod(mode)
        return path

    def backups(self) -> list[Path]:
        return sorted(self.live.parent.glob(f"{self.live.name}.backup-*"))

    def assert_refused_without_changes(
        self, result: subprocess.CompletedProcess[str]
    ) -> None:
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertTrue(self.live.is_dir())
        self.assertFalse(self.live.is_symlink())
        self.assertEqual(self.backups(), [])

    def test_unsupported_platforms_refuse_rename_without_changes(self) -> None:
        for root in (self.live, self.canonical):
            self.write_file(root, "skill/run.sh", b"#!/bin/sh\n", 0o755)
        runner = f"""
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("migrator", {str(MIGRATOR)!r})
migrator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migrator)
migrator.sys.platform = sys.argv[1]
sys.exit(migrator.main(sys.argv[2:]))
"""
        for platform in ("linux", "win32"):
            with self.subTest(platform=platform):
                result = subprocess.run(
                    [
                        sys.executable,
                        "-c",
                        runner,
                        platform,
                        str(self.live),
                        str(self.canonical),
                    ],
                    capture_output=True,
                    check=False,
                    text=True,
                )

                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("atomic no-replace rename is unsupported", result.stderr)
                self.assert_refused_without_changes(result)
                for root in (self.live, self.canonical):
                    script = root / "skill/run.sh"
                    self.assertEqual(script.read_bytes(), b"#!/bin/sh\n")
                    self.assertEqual(stat.S_IMODE(script.stat().st_mode), 0o755)

    def test_absent_directory_is_linked_to_canonical_directory(self) -> None:
        self.live.rmdir()
        result = self.run_migration()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.live.is_symlink())
        self.assertEqual(self.live.resolve(), self.canonical.resolve())
        self.assertIn("Linked skills directory", result.stdout)

    def test_absent_directory_with_missing_parent_is_created(self) -> None:
        self.live.rmdir()
        self.live.parent.rmdir()

        result = self.run_migration()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.live.is_symlink())
        self.assertEqual(self.live.resolve(), self.canonical.resolve())

    def test_existing_directory_is_backed_up_and_future_writes_reach_canonical(
        self,
    ) -> None:
        self.write_file(self.canonical, "guide/SKILL.md", b"same\n", 0o755)
        self.write_file(self.canonical, "guide/module.pyd", b"compiled extension")
        self.write_file(self.live, "guide/SKILL.md", b"same\n", 0o755)
        self.write_file(self.live, ".DS_Store", b"finder metadata")
        self.write_file(self.live, "guide/__pycache__/module.pyc", b"compiled cache")
        self.write_file(self.live, "guide/module.pyc", b"bytecode cache")
        self.write_file(self.live, "guide/module.pyo", b"optimized bytecode cache")
        self.write_file(self.live, "guide/module.pyd", b"compiled extension")

        result = self.run_migration()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.live.is_symlink())
        backups = self.backups()
        self.assertEqual(len(backups), 1)
        backup = backups[0]
        self.assertEqual((backup / ".DS_Store").read_bytes(), b"finder metadata")
        self.assertEqual(
            (backup / "guide/__pycache__/module.pyc").read_bytes(), b"compiled cache"
        )
        self.assertEqual((backup / "guide/module.pyc").read_bytes(), b"bytecode cache")
        self.assertEqual(
            (backup / "guide/module.pyo").read_bytes(), b"optimized bytecode cache"
        )
        self.assertEqual(
            (backup / "guide/module.pyd").read_bytes(), b"compiled extension"
        )
        self.assertEqual(
            stat.S_IMODE((backup / "guide/SKILL.md").stat().st_mode), 0o755
        )
        self.assertIn(str(backup), result.stdout)

        future_skill = self.live / "future-skill" / "SKILL.md"
        future_skill.parent.mkdir()
        future_skill.write_text("visible immediately\n", encoding="utf-8")
        self.assertEqual(
            (self.canonical / "future-skill/SKILL.md").read_text(encoding="utf-8"),
            "visible immediately\n",
        )

    def test_existing_home_manager_child_links_are_accepted_and_preserved_in_backup(
        self,
    ) -> None:
        for skill in ("browser-routing", "one-bin"):
            (self.canonical / skill).mkdir()
            (self.canonical / skill / "SKILL.md").write_text(skill, encoding="utf-8")
            (self.live / skill).symlink_to(self.canonical / skill)

        result = self.run_migration()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.live.is_symlink())
        backup = self.backups()[0]
        for skill in ("browser-routing", "one-bin"):
            self.assertTrue((backup / skill).is_symlink())
            self.assertEqual(
                (backup / skill).resolve(), (self.canonical / skill).resolve()
            )

    def test_unrelated_root_symlink_is_refused(self) -> None:
        other = self.root / "other-skills"
        other.mkdir()
        self.live.rmdir()
        self.live.symlink_to(other)

        result = self.run_migration()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unrelated skills symlink", result.stderr)
        self.assertEqual(self.live.resolve(), other.resolve())
        self.assertEqual(self.backups(), [])

    def test_broken_root_symlink_is_refused_without_changes(self) -> None:
        missing = self.root / "missing-skills"
        self.live.rmdir()
        self.live.symlink_to(missing)

        result = self.run_migration()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("broken symlink", result.stderr)
        self.assertTrue(self.live.is_symlink())
        self.assertEqual(os.readlink(self.live), str(missing))
        self.assertEqual(self.backups(), [])

    def test_canonical_root_symlink_is_idempotent(self) -> None:
        self.live.rmdir()
        self.live.symlink_to(self.canonical)

        result = self.run_migration()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.live.is_symlink())
        self.assertIn("already points", result.stdout)
        self.assertEqual(self.backups(), [])

    def test_unknown_local_file_is_refused_without_changes(self) -> None:
        self.write_file(self.live, "unknown.txt", b"not imported")

        result = self.run_migration()

        self.assert_refused_without_changes(result)
        self.assertIn("unknown.txt", result.stderr)
        self.assertEqual((self.live / "unknown.txt").read_bytes(), b"not imported")

    def test_unknown_local_directory_is_refused_without_changes(self) -> None:
        (self.live / "untracked-skill").mkdir()

        result = self.run_migration()

        self.assert_refused_without_changes(result)
        self.assertIn("untracked-skill", result.stderr)

    def test_mismatching_file_bytes_are_refused_without_changes(self) -> None:
        self.write_file(self.canonical, "skill/SKILL.md", b"canonical\n")
        self.write_file(self.live, "skill/SKILL.md", b"local edit\n")

        result = self.run_migration()

        self.assert_refused_without_changes(result)
        self.assertIn("contents differ", result.stderr)
        self.assertEqual((self.live / "skill/SKILL.md").read_bytes(), b"local edit\n")

    def test_missing_canonical_file_is_refused_without_changes(self) -> None:
        self.write_file(self.live, "skill/SKILL.md", b"local content")

        result = self.run_migration()

        self.assert_refused_without_changes(result)
        self.assertIn("missing from the canonical", result.stderr)

    def test_missing_canonical_pyd_is_refused_without_changes(self) -> None:
        (self.canonical / "skill").mkdir()
        self.write_file(self.live, "skill/native-extension.pyd", b"compiled extension")

        result = self.run_migration()

        self.assert_refused_without_changes(result)
        self.assertIn("native-extension.pyd", result.stderr)
        self.assertIn("missing from the canonical", result.stderr)

    def test_file_directory_type_mismatch_is_refused_without_changes(self) -> None:
        self.write_file(self.canonical, "skill", b"canonical file")
        (self.live / "skill").mkdir()

        result = self.run_migration()

        self.assert_refused_without_changes(result)
        self.assertIn("Local directory skill is not a directory", result.stderr)

    def test_executable_mode_mismatch_is_refused_without_changes(self) -> None:
        self.write_file(self.canonical, "skill/run.sh", b"#!/bin/sh\n", 0o755)
        self.write_file(self.live, "skill/run.sh", b"#!/bin/sh\n", 0o644)

        result = self.run_migration()

        self.assert_refused_without_changes(result)
        self.assertIn("Executable mode differs", result.stderr)

    def test_unrelated_nested_symlink_is_refused_without_changes(self) -> None:
        target = self.root / "outside"
        target.write_text("external", encoding="utf-8")
        (self.live / "external-link").symlink_to(target)

        result = self.run_migration()

        self.assert_refused_without_changes(result)
        self.assertIn("Unsupported local symlink at external-link", result.stderr)

    def test_matching_nested_symlinks_are_refused_without_changes(self) -> None:
        self.write_file(self.canonical, "skill/assets/data", b"canonical data")
        self.write_file(self.live, "skill/assets/data", b"canonical data")
        (self.canonical / "skill/current").symlink_to("assets/data")
        (self.live / "skill/current").symlink_to("assets/data")

        result = self.run_migration()

        self.assert_refused_without_changes(result)
        self.assertIn("Unsupported local symlink at skill/current", result.stderr)
        self.assertTrue((self.live / "skill/current").is_symlink())
        self.assertTrue((self.canonical / "skill/current").is_symlink())
        self.assertEqual(
            os.readlink(self.live / "skill/current"),
            os.readlink(self.canonical / "skill/current"),
        )

    def test_dry_run_checks_existing_directory_without_mutation(self) -> None:
        self.write_file(self.canonical, "skill/SKILL.md", b"same\n")
        self.write_file(self.live, "skill/SKILL.md", b"same\n")

        result = self.run_migration(dry_run=True)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.live.is_dir())
        self.assertFalse(self.live.is_symlink())
        self.assertEqual((self.live / "skill/SKILL.md").read_bytes(), b"same\n")
        self.assertEqual(self.backups(), [])
        self.assertIn("Would preserve", result.stdout)
        self.assertIn("Would link", result.stdout)

    def test_dry_run_of_absent_directory_does_not_create_parent_or_link(self) -> None:
        self.live.rmdir()
        self.live.parent.rmdir()

        result = self.run_migration(dry_run=True)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.live.parent.exists())
        self.assertFalse(os.path.lexists(self.live))
        self.assertIn("Would link", result.stdout)

    def test_non_directory_root_is_refused(self) -> None:
        self.live.rmdir()
        self.live.write_text("keep me", encoding="utf-8")

        result = self.run_migration()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not a directory", result.stderr)
        self.assertEqual(self.live.read_text(encoding="utf-8"), "keep me")
        self.assertEqual(self.backups(), [])

    def test_link_failure_restores_the_original_directory(self) -> None:
        for root in (self.live, self.canonical):
            self.write_file(root, "skill/SKILL.md", b"original content")

        result = self.run_migration_with_link_failure()

        self.assert_refused_without_changes(result)
        self.assertIn("Original directory was restored", result.stderr)
        self.assertEqual(
            (self.live / "skill/SKILL.md").read_bytes(), b"original content"
        )

    def test_link_failure_never_overwrites_a_concurrently_created_path(self) -> None:
        for root in (self.live, self.canonical):
            self.write_file(root, "skill/SKILL.md", b"original content")

        result = self.run_migration_with_link_failure(concurrent_path=True)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Original data remains at", result.stderr)
        self.assertEqual(
            (self.live / "concurrent.txt").read_text(), "preserve concurrent data"
        )
        self.assertEqual(len(self.backups()), 1)
        self.assertEqual(
            (self.backups()[0] / "skill/SKILL.md").read_bytes(), b"original content"
        )

    def test_live_path_inside_canonical_directory_is_refused(self) -> None:
        self.live = self.canonical / "nested-live"
        self.live.mkdir()

        result = self.run_migration()

        self.assert_refused_without_changes(result)
        self.assertIn("inside the canonical", result.stderr)

    def test_absent_live_path_inside_canonical_directory_is_refused(self) -> None:
        self.live = self.canonical / "nested-live"

        result = self.run_migration()

        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(os.path.lexists(self.live))
        self.assertIn("inside the canonical", result.stderr)

    def test_nonexistent_canonical_directory_is_refused(self) -> None:
        self.canonical.rmdir()

        result = self.run_migration()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Canonical skills directory does not exist", result.stderr)
        self.assertTrue(self.live.is_dir())
        self.assertEqual(self.backups(), [])

    def test_emitted_activation_hooks_preflight_and_honor_dry_run_presence(
        self,
    ) -> None:
        nix = shutil.which("nix")
        if nix is None:
            self.skipTest(
                "nix is required to evaluate the Home Manager activation hooks"
            )

        fixture_root = self.root / "activation-fixture"
        fixture_home = fixture_root / "Users" / "dmitrijarkov"
        canonical = fixture_home / ".dotfiles" / "home" / ".agents" / "skills"
        live = fixture_home / ".agents" / "skills"
        canonical.mkdir(parents=True)

        lock = json.loads((REPOSITORY_ROOT / "flake.lock").read_text(encoding="utf-8"))
        home_manager_rev = lock["nodes"]["home-manager"]["locked"]["rev"]
        nixpkgs_rev = lock["nodes"]["nixpkgs"]["locked"]["rev"]
        expression = f"""
          let
            homeManager = builtins.getFlake "github:nix-community/home-manager/{home_manager_rev}";
            nixpkgs = builtins.getFlake "github:NixOS/nixpkgs/{nixpkgs_rev}";
            pkgs = import nixpkgs {{ system = "aarch64-darwin"; }};
            home = homeManager.lib.homeManagerConfiguration {{
              inherit pkgs;
              modules = [
                (import ./home.nix)
                ({{ lib, ... }}: {{
                  home.homeDirectory = lib.mkForce {json.dumps(str(fixture_home))};
                }})
              ];
              extraSpecialArgs = {{ user = "dmitrijarkov"; }};
            }};
          in {{
            preflight = home.config.home.activation.preflightAgentSkills.data;
            migration = home.config.home.activation.migrateAgentSkills.data;
            bash = toString pkgs.bash + "/bin/bash";
          }}
        """
        evaluated = subprocess.run(
            [nix, "eval", "--impure", "--json", "--expr", expression],
            cwd=REPOSITORY_ROOT,
            capture_output=True,
            check=False,
            text=True,
        )
        self.assertEqual(evaluated.returncode, 0, evaluated.stderr)
        hooks = json.loads(evaluated.stdout)

        def run_hook(
            script: str, dry_run: str | None
        ) -> subprocess.CompletedProcess[str]:
            environment = os.environ.copy()
            environment["HOME"] = str(fixture_home)
            if dry_run is None:
                environment.pop("DRY_RUN", None)
            else:
                environment["DRY_RUN"] = dry_run
            return subprocess.run(
                [hooks["bash"], "-c", script],
                env=environment,
                capture_output=True,
                check=False,
                text=True,
            )

        for dry_run in ("", "0", None):
            with self.subTest(DRY_RUN=dry_run):
                if live.is_symlink() or live.is_file():
                    live.unlink()
                elif live.exists():
                    shutil.rmtree(live)
                live.mkdir(parents=True)
                self.write_file(canonical, "example/SKILL.md", b"same skill\n")
                self.write_file(live, "example/SKILL.md", b"same skill\n")

                preflight = run_hook(hooks["preflight"], dry_run)
                self.assertEqual(preflight.returncode, 0, preflight.stderr)
                self.assertTrue(live.is_dir())
                self.assertFalse(live.is_symlink())
                self.assertEqual(list(live.parent.glob("skills.backup-*")), [])

                migration = run_hook(hooks["migration"], dry_run)
                self.assertEqual(migration.returncode, 0, migration.stderr)
                if dry_run is None:
                    self.assertTrue(live.is_symlink())
                    backups = list(live.parent.glob("skills.backup-*"))
                    self.assertEqual(len(backups), 1)
                    self.assertEqual(
                        (backups[0] / "example/SKILL.md").read_bytes(), b"same skill\n"
                    )
                    self.assertEqual(live.resolve(), canonical.resolve())
                else:
                    self.assertTrue(live.is_dir())
                    self.assertFalse(live.is_symlink())
                    self.assertEqual(list(live.parent.glob("skills.backup-*")), [])


if __name__ == "__main__":
    unittest.main()
