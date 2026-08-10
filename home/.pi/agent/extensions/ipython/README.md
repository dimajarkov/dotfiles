# Persistent IPython primary tool for Pi

This global Pi extension ports Prime Agent's persistent IPython control-environment philosophy to the Pi harness.
It uses a real Jupyter kernel, preserves Python state across tool calls and turns, snapshots serializable names for session resume, supports top-level `await` and `%%bash`, and renders compact Prime-style notebook rows in the TUI.

## Behavior

- `ipython` becomes the primary local tool.
- Pi's local `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` tools are disabled by default.
- App, web, MCP, and other extension tools stay active.
- Discovered Markdown skills remain visible to the model even though Pi's built-in `read` tool is disabled.
- Extension-owned `edit` and `attach_image` Python helpers are always installed and pre-imported.
- Set `PI_IPYTHON_KEEP_BUILTINS=1` before starting Pi to retain the local built-ins.
- Python-backed skills are loaded from trusted global roots.
- Set `PI_IPYTHON_PROJECT_SKILLS=1` only for a trusted checkout to allow project-local Python package build and import code.
- Use `/ipython` to inspect kernel status and live names.
- Use `/ipython-reset` to clear the kernel and its saved namespace.
- Use Ctrl+O to expand or collapse notebook cells.
- Reasoning summaries remain visible so Pi shows Prime-style progress headings before tool groups.

## Prime-style reporting

Pi's progress headings are provider reasoning summaries, not IPython output.
The global setting `hideThinkingBlock: false` keeps those summaries visible, matching Prime Agent's default presentation.
The IPython renderer supplies the compact `✓ python · preview · ↑ input ↓ output lines · duration` rows and composite `bash · python` labels for Python heredocs.

## Kernel environment

The first session creates `~/.pi/agent/ipython-venv` with `uv` and Python 3.11.13.
The environment includes the same general-purpose package set used by Prime Agent: requests, httpx, PyYAML, tomli, python-dotenv, pandas, NumPy, SciPy, Beautiful Soup, lxml, Pydantic, and tyro.
Every direct and transitive dependency is version-locked with SHA256 hashes in `requirements.lock`.
Home Manager installs `uv`, and the first kernel setup downloads the exact locked Python runtime and base packages.
Trusted Python skill packages are installed separately from their local source trees.
Set `PI_IPYTHON_PYTHON` to an existing compatible interpreter, or set `PI_IPYTHON_VENV` to move the managed environment.

Do not install target-project dependencies into this kernel merely to run the target project.
Run project imports, tests, scripts, and CLIs through the project's own documented environment from a `%%bash` cell.

Use `await edit(path, old_str, new_str)` for atomic exact edits with structured diffs.
Use `await attach_image(path)` to add a supported image to model context when the selected model accepts images.

## FirstMate compatibility

FirstMate's Pi adapter inspects the shell body of IPython `%%bash` and shell-backed `%%script` cells before execution.
Its cwd and watcher-arm seatbelts therefore remain effective when the global `bash` tool is disabled.
FirstMate's `.agents/skills` catalog remains model-visible through the IPython skill-prompt bridge.

## Persistence and output

One kernel is prewarmed per Pi session and remains alive through turns and compaction.
Serializable namespace values are saved under `~/.pi/agent/session-artifacts/<session-id>/` with `dill` and restored on resume.
Objects that cannot be serialized are skipped.

Model-visible output is limited to Pi's 2000-line or 50KB tool limit.
Larger streamed output is saved under `~/.pi/agent/tool-output/` and the result reports its path.

## Scope of parity

This extension aligns Pi with Prime Agent's persistent IPython execution model and compact notebook presentation.
Prime-only harness services such as recursive `rlm` subagents and daemon-backed workers are not emulated by this extension.
Continual harness state is provided by the companion `prime-parity.ts` extension.
Pi extensions and MCP tools remain available through their native Pi interfaces.
Python-backed skills in global roots are installed into the managed kernel and exposed as callable imports.
Project-root Python packages require the explicit `PI_IPYTHON_PROJECT_SKILLS=1` trust opt-in.

## Upstream attribution

The Jupyter protocol manager, namespace snapshot mechanism, smart code-preview logic, and rendering design are adapted from Prime Agent at commit `a18809e00ea30638584d87b3afea7285a9d7296c`.
Prime Agent is available at <https://github.com/PrimeIntellect-ai/prime-agent>.
The upstream MIT terms are preserved in `UPSTREAM_LICENSE`.
