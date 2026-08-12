#!/usr/bin/env python3
"""Treehouse + Herdr feature-runtime topology orchestrator."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time
from typing import Any, Sequence


class WorkflowError(RuntimeError):
    pass


def canonical(path: str | Path) -> str:
    return str(Path(path).expanduser().resolve(strict=True))


def parse_command_json(raw: str, label: str) -> list[str]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise WorkflowError(f"{label} must be a JSON string array: {error}") from error
    if not isinstance(value, list) or not value or not all(isinstance(item, str) and item for item in value):
        raise WorkflowError(f"{label} must be a non-empty JSON string array.")
    return value


def shell_command(argv: Sequence[str]) -> str:
    return shlex.join(argv)


def select_durable_lease(entries: Any, worktree_path: str) -> dict[str, Any]:
    if not isinstance(entries, list):
        raise WorkflowError("treehouse status --json did not return an array.")
    target = canonical(worktree_path)
    matches = []
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            continue
        try:
            if canonical(entry["path"]) == target:
                matches.append(entry)
        except (FileNotFoundError, OSError):
            continue
    if len(matches) != 1:
        raise WorkflowError(f"Expected one Treehouse row for {target}; found {len(matches)}.")
    entry = matches[0]
    if (
        entry.get("status") != "leased"
        or not isinstance(entry.get("lease_id"), str)
        or not entry["lease_id"].strip()
        or not isinstance(entry.get("lease_holder"), str)
        or not entry["lease_holder"].strip()
    ):
        raise WorkflowError(
            "Long-lived runtime refused: Treehouse process-only in-use state is not a durable lease with a non-empty ID and holder."
        )
    return {
        "path": target,
        "status": "leased",
        "lease_id": entry["lease_id"],
        "lease_holder": entry["lease_holder"],
        "leased_at": entry.get("leased_at"),
    }


def validate_tabs(tabs: Any, workspace_id: str) -> tuple[dict[str, Any], dict[str, Any] | None]:
    if not isinstance(tabs, list):
        raise WorkflowError("Herdr tab list did not return an array.")
    feature_tabs = [tab for tab in tabs if tab.get("label") == "feature-agent"]
    runtime_tabs = [tab for tab in tabs if tab.get("label") == "runtime"]
    if len(feature_tabs) != 1:
        raise WorkflowError(f"Workspace {workspace_id} must contain exactly one feature-agent tab; found {len(feature_tabs)}.")
    if len(runtime_tabs) > 1:
        raise WorkflowError(f"Workspace {workspace_id} has conflicting runtime tabs; found {len(runtime_tabs)}.")
    return feature_tabs[0], runtime_tabs[0] if runtime_tabs else None


def validate_agent_name(name: str, agents: Any) -> None:
    import re
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", name):
        raise WorkflowError("Agent name must match [a-z][a-z0-9_-]{0,31}.")
    if not isinstance(agents, list):
        raise WorkflowError("Herdr agent list did not return an array.")
    if any(agent.get("name") == name for agent in agents):
        raise WorkflowError(f"Herdr agent name {name} is already in use.")


class Commands:
    def __init__(self, session: str) -> None:
        self.session = session

    def run(self, argv: Sequence[str], *, cwd: str | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(list(argv), cwd=cwd, text=True, capture_output=True)
        if check and result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip() or "no output"
            raise WorkflowError(f"{shell_command(argv)} failed ({result.returncode}): {detail}")
        return result

    def json(self, argv: Sequence[str], *, cwd: str | None = None) -> Any:
        result = self.run(argv, cwd=cwd)
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise WorkflowError(f"{shell_command(argv)} returned invalid JSON: {error}") from error

    def herdr(self, *args: str) -> Any:
        return self.json(["herdr", "--session", self.session, *args])

    def herdr_run(self, pane_id: str, command: str) -> None:
        self.run(["herdr", "--session", self.session, "pane", "run", pane_id, command])


def result_at(document: Any, *path: str) -> Any:
    current = document
    for segment in path:
        if not isinstance(current, dict) or segment not in current:
            raise WorkflowError(f"Command JSON is missing {'.'.join(path)}.")
        current = current[segment]
    return current


def pane_is_available(commands: Commands, pane_id: str, expected_cwd: str) -> None:
    shells = {"zsh", "bash", "fish", "sh"}
    last_foreground: Any = []
    for _ in range(20):
        pane = result_at(commands.herdr("pane", "get", pane_id), "result", "pane")
        pane_cwd = pane.get("foreground_cwd") or pane.get("cwd")
        if not isinstance(pane_cwd, str) or canonical(pane_cwd) != expected_cwd:
            raise WorkflowError(f"Pane {pane_id} cwd does not match leased checkout {expected_cwd}.")
        process = result_at(
            commands.herdr("pane", "process-info", "--pane", pane_id),
            "result",
            "process_info",
        )
        last_foreground = process.get("foreground_processes", [])
        if not last_foreground or all(
            Path(str(item.get("argv0", ""))).name.lstrip("-") in shells
            for item in last_foreground
        ):
            return
        time.sleep(0.25)
    raise WorkflowError(
        f"Pane {pane_id} is occupied by a foreign foreground process: {last_foreground}."
    )


def root_pane_for_tab(commands: Commands, workspace_id: str, tab_id: str) -> str:
    panes = result_at(commands.herdr("pane", "list", "--workspace", workspace_id), "result", "panes")
    matches = [pane for pane in panes if pane.get("tab_id") == tab_id]
    if len(matches) != 1:
        raise WorkflowError(f"Tab {tab_id} must have exactly one pane before orchestration; found {len(matches)}.")
    pane_id = matches[0].get("pane_id")
    if not isinstance(pane_id, str):
        raise WorkflowError(f"Tab {tab_id} has no pane ID.")
    return pane_id


def create_or_reuse_topology(commands: Commands, workspace_id: str | None, worktree_path: str, label: str) -> dict[str, str]:
    if workspace_id is None:
        created = commands.herdr("workspace", "create", "--cwd", worktree_path, "--label", label, "--no-focus")
        workspace_id = result_at(created, "result", "workspace", "workspace_id")
        feature_tab_id = result_at(created, "result", "tab", "tab_id")
        feature_pane_id = result_at(created, "result", "root_pane", "pane_id")
        commands.herdr("tab", "rename", feature_tab_id, "feature-agent")
    else:
        workspace = result_at(commands.herdr("workspace", "get", workspace_id), "result", "workspace")
        if workspace.get("workspace_id") != workspace_id:
            raise WorkflowError("Herdr returned a different workspace identity.")
        tabs = result_at(commands.herdr("tab", "list", "--workspace", workspace_id), "result", "tabs")
        feature_tab, _ = validate_tabs(tabs, workspace_id)
        feature_tab_id = feature_tab["tab_id"]
        feature_pane_id = root_pane_for_tab(commands, workspace_id, feature_tab_id)

    tabs = result_at(commands.herdr("tab", "list", "--workspace", workspace_id), "result", "tabs")
    feature_tab, runtime_tab = validate_tabs(tabs, workspace_id)
    feature_tab_id = feature_tab["tab_id"]
    feature_pane_id = root_pane_for_tab(commands, workspace_id, feature_tab_id)
    pane_is_available(commands, feature_pane_id, worktree_path)
    if runtime_tab is None:
        created = commands.herdr("tab", "create", "--workspace", workspace_id, "--cwd", worktree_path, "--label", "runtime", "--no-focus")
        runtime_tab_id = result_at(created, "result", "tab", "tab_id")
        runtime_pane_id = result_at(created, "result", "root_pane", "pane_id")
    else:
        runtime_tab_id = runtime_tab["tab_id"]
        runtime_pane_id = root_pane_for_tab(commands, workspace_id, runtime_tab_id)
    tabs = result_at(commands.herdr("tab", "list", "--workspace", workspace_id), "result", "tabs")
    _, runtime_tab = validate_tabs(tabs, workspace_id)
    if runtime_tab is None:
        raise WorkflowError("Runtime tab creation was not observable.")
    pane_is_available(commands, runtime_pane_id, worktree_path)
    return {
        "workspace_id": workspace_id,
        "feature_tab_id": feature_tab_id,
        "feature_pane_id": feature_pane_id,
        "runtime_tab_id": runtime_tab_id,
        "runtime_pane_id": runtime_pane_id,
    }


def wait_for_readiness(commands: Commands, argv: list[str], cwd: str, timeout_seconds: int) -> Any:
    deadline = time.monotonic() + timeout_seconds
    last = "not run"
    while time.monotonic() < deadline:
        result = commands.run(argv, cwd=cwd, check=False)
        if result.returncode == 0:
            try:
                return json.loads(result.stdout)
            except json.JSONDecodeError as error:
                raise WorkflowError(f"Readiness command passed but returned invalid JSON: {error}") from error
        last = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        time.sleep(2)
    raise WorkflowError(f"Runtime readiness timed out after {timeout_seconds}s: {last}")


def wait_for_agent(commands: Commands, pane_id: str, cwd: str, timeout_seconds: int) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        result = commands.run(["herdr", "--session", commands.session, "agent", "get", pane_id], check=False)
        if result.returncode == 0:
            document = json.loads(result.stdout)
            agent = result_at(document, "result", "agent")
            if agent.get("agent") == "prime-agent":
                foreground_cwd = agent.get("foreground_cwd")
                if not isinstance(foreground_cwd, str) or canonical(foreground_cwd) != cwd:
                    raise WorkflowError("Fresh Prime Agent foreground cwd does not match the leased checkout.")
                return agent
        time.sleep(1)
    raise WorkflowError(f"Herdr did not recognize a fresh Prime Agent in {pane_id} within {timeout_seconds}s.")


def atomic_receipt(path: str, value: Any) -> None:
    target = Path(path).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2)
            handle.write("\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--caller-pane-id", required=True)
    parser.add_argument("--source-checkout", required=True)
    parser.add_argument("--feature-slug", required=True)
    parser.add_argument("--workspace-label", required=True)
    allocation = parser.add_mutually_exclusive_group(required=True)
    allocation.add_argument("--create-command-json")
    allocation.add_argument("--existing-worktree")
    parser.add_argument("--metadata-path")
    parser.add_argument("--expected-lease-id")
    parser.add_argument("--expected-lease-holder")
    parser.add_argument("--runtime-command-json", required=True)
    parser.add_argument("--readiness-command-json", required=True)
    parser.add_argument("--handoff", required=True)
    parser.add_argument("--agent-name", required=True)
    parser.add_argument("--agent-goal-budget", type=int, default=12000)
    parser.add_argument("--readiness-timeout", type=int, default=600)
    parser.add_argument("--agent-timeout", type=int, default=60)
    parser.add_argument("--workspace-id")
    parser.add_argument("--receipt", required=True)
    args = parser.parse_args(argv)

    if os.environ.get("HERDR_ENV") != "1" or not os.environ.get("HERDR_SESSION"):
        raise WorkflowError("This workflow requires the caller's named Herdr session.")
    session = os.environ["HERDR_SESSION"]
    commands = Commands(session)
    source = canonical(args.source_checkout)
    live_agents = result_at(commands.herdr("agent", "list"), "result", "agents")
    validate_agent_name(args.agent_name, live_agents)
    caller = result_at(commands.herdr("pane", "get", args.caller_pane_id), "result", "pane")
    caller_cwd = caller.get("foreground_cwd") or caller.get("cwd")
    if not isinstance(caller_cwd, str) or canonical(caller_cwd) != source:
        raise WorkflowError("Explicit caller pane does not belong to the source checkout.")

    create_argv: list[str] | None = None
    if args.create_command_json:
        create_argv = parse_command_json(args.create_command_json, "--create-command-json")
        create = commands.run(create_argv, cwd=source)
        try:
            created = json.loads(create.stdout)
        except json.JSONDecodeError as error:
            raise WorkflowError(f"Project allocator returned invalid JSON: {error}") from error
        worktree_path = canonical(result_at(created, "plan", "worktreePath"))
        metadata_path = canonical(result_at(created, "metadataPath"))
    else:
        if not args.metadata_path or not args.workspace_id:
            raise WorkflowError("--existing-worktree requires --metadata-path and --workspace-id.")
        if not args.expected_lease_id or not args.expected_lease_holder:
            raise WorkflowError("Resume requires the recorded --expected-lease-id and --expected-lease-holder.")
        worktree_path = canonical(args.existing_worktree)
        metadata_path = canonical(args.metadata_path)
    lease = select_durable_lease(commands.json(["treehouse", "status", "--json"], cwd=source), worktree_path)
    if args.existing_worktree and (
        lease["lease_id"] != args.expected_lease_id
        or lease["lease_holder"] != args.expected_lease_holder
    ):
        raise WorkflowError("Recorded durable lease identity no longer owns the checkout.")
    metadata = json.loads(Path(metadata_path).read_text(encoding="utf-8"))
    if canonical(metadata.get("worktreePath", "")) != worktree_path:
        raise WorkflowError("Project runtime metadata belongs to a foreign checkout.")
    metadata_lease = metadata.get("treehouseLease")
    if not isinstance(metadata_lease, dict) or (
        metadata_lease.get("id") != lease["lease_id"]
        or metadata_lease.get("holder") != lease["lease_holder"]
    ):
        raise WorkflowError("Project runtime metadata has a foreign or missing durable lease identity.")

    topology = create_or_reuse_topology(commands, args.workspace_id, worktree_path, args.workspace_label)
    runtime_argv = parse_command_json(args.runtime_command_json, "--runtime-command-json")
    readiness_argv = parse_command_json(args.readiness_command_json, "--readiness-command-json")
    commands.herdr("pane", "rename", topology["runtime_pane_id"], f"{args.feature_slug} full runtime")
    commands.herdr_run(topology["runtime_pane_id"], shell_command(runtime_argv))
    readiness = wait_for_readiness(commands, readiness_argv, worktree_path, args.readiness_timeout)

    pane_is_available(commands, topology["feature_pane_id"], worktree_path)
    agent_argv = [
        "prime-agent",
        "--cwd",
        worktree_path,
        "--goal",
        args.handoff,
        "--goal-token-budget",
        str(args.agent_goal_budget),
        "--",
        "Read the repository instructions and runtime metadata, verify the readiness receipt, then remain ready for the feature work.",
    ]
    commands.herdr("pane", "rename", topology["feature_pane_id"], f"{args.feature_slug} feature agent")
    commands.herdr_run(topology["feature_pane_id"], shell_command(agent_argv))
    agent = wait_for_agent(commands, topology["feature_pane_id"], worktree_path, args.agent_timeout)
    commands.herdr("agent", "rename", topology["feature_pane_id"], args.agent_name)
    final_lease = select_durable_lease(
        commands.json(["treehouse", "status", "--json"], cwd=source), worktree_path
    )
    if final_lease["lease_id"] != lease["lease_id"] or final_lease["lease_holder"] != lease["lease_holder"]:
        raise WorkflowError("Durable Treehouse lease identity changed during orchestration.")

    receipt = {
        "schemaVersion": 1,
        "status": "pass",
        "session": session,
        "sourceCheckout": source,
        "featureSlug": args.feature_slug,
        "metadataPath": metadata_path,
        "worktreePath": worktree_path,
        "branch": metadata.get("branch"),
        "sourceHead": metadata.get("sourceHead"),
        "lease": lease,
        "herdr": topology,
        "createCommand": create_argv,
        "runtimeCommand": runtime_argv,
        "readinessCommand": readiness_argv,
        "readiness": readiness,
        "agent": {
            "name": args.agent_name,
            "kind": agent.get("agent"),
            "pane_id": agent.get("pane_id"),
            "foreground_cwd": agent.get("foreground_cwd"),
            "goalBudget": args.agent_goal_budget,
        },
    }
    atomic_receipt(args.receipt, receipt)
    print(json.dumps({**receipt, "receiptPath": canonical(args.receipt)}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except WorkflowError as error:
        print(f"feature-runtime: {error}", file=sys.stderr)
        raise SystemExit(1)
