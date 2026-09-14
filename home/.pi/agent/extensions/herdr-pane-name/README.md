# Herdr pane naming

Automatically names the calling Herdr pane from a Pi conversation's first request.
It changes the pane label, not the agent's coordination name or the terminal's status/spinner title.

- Runs only in interactive Pi (`ctx.mode === "tui"`) with `HERDR_ENV=1` and a caller pane ID.
- Uses one background, tool-free request to the selected Pi model through its existing authentication.
- Sends at most 8,000 characters of the first request, not the conversation, attachments, or project context.
- Asks for a 3-6 word title, limited to 48 Unicode code points.
- Saves the title as a Pi custom entry, outside the model's conversation context.
- Keeps the title stable across follow-ups, compaction, and tree navigation.
- Restores the saved title on resume, reload, and forks that retain that entry.
- Older sessions without a saved title are named from their original first user message.
- `/new` starts fresh and names the pane after its first request arrives.
- If generation fails or times out after 15 seconds, uses a bounded excerpt of the first request and shows a warning.
- Image-only requests use `Image request` without sending image data to a second model call.
- Missing Herdr context and print/JSON/RPC subprocesses are no-ops.

Pane names are visible in Herdr, including fallback request excerpts.
A manual Herdr rename stays intact during follow-ups, but resuming or reloading Pi restores the saved automatic title.
The previous pane label remains while a new title is being generated.
The generated label remains when Pi exits.

## Installation

Home Manager declares this directory in `home.nix` as `~/.pi/agent/extensions/herdr-pane-name`.
Pi discovers `index.ts` automatically.
Run `/reload` in an existing Pi session, or start a new session, after installing it.
Do not edit the Herdr-managed `herdr-agent-state.ts` integration to customize naming.

## Checks

Requires Node.js with TypeScript type stripping (Node 23.6+ or a current LTS).

```sh
cd ~/dotfiles/home/.pi/agent/extensions/herdr-pane-name
npm ci
npm test
npm run lint
npm run format:check
```

The tests cover lifecycle restoration, first-request selection, background execution, cancellation, caller targeting after pane moves, failure fallback, non-interactive isolation, and safe title handling.
For a live check, open a disposable Herdr pane and start interactive Pi with this extension.
Send a first request, inspect its pane label with `herdr pane get <pane-id>`, send an unrelated follow-up, then verify `/reload`, `/new`, and session resume behavior.
Close only the disposable pane after testing.
