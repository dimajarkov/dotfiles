# LazyGit extensions and experience improvements

Research completed on 2026-10-06 using LazyGit's current upstream documentation, the documentation for the installed LazyGit 0.61.1, its community Custom Commands Compendium, and Git Town's integration guide.

## Conclusion

People do improve LazyGit with external tools, but the supported pattern is configuration and shell-backed custom commands, not installing conventional UI plugins.
The official docs document custom commands, diff renderers, keybindings, themes, icons, and repository-specific configuration, but no plugin loader or plugin manager ([custom commands](https://github.com/jesseduffield/lazygit/blob/master/docs/Custom_Command_Keybindings.md), [configuration](https://github.com/jesseduffield/lazygit/blob/master/docs/Config.md)).
The closest shared catalog is the [community Custom Commands Compendium](https://github.com/jesseduffield/lazygit/wiki/Custom-Commands-Compendium).

## Best additions to consider

### Better diffs

The upstream maintainer strongly recommends using a custom diff renderer and says Delta is their personal preference.
Delta adds syntax-aware diff presentation and can provide clickable line-number links back to an editor.
Difftastic provides a structural diff view, while diff-so-fancy and ydiff are alternatives.
Multiple renderers can be configured and cycled with `|` ([official diff-renderer guide](https://github.com/jesseduffield/lazygit/blob/master/docs/Custom_DiffRenderers.md)).
The existing `home/.config/lazygit/config.yml` in this repo already configures Delta using `git.pagers`, which is the correct format for the installed LazyGit 0.61.1.
That version can add Difftastic as a second pager with `externalDiffCommand: difft --color=always`, then cycle between Delta and Difftastic with `|` ([v0.61.1 pager guide](https://github.com/jesseduffield/lazygit/blob/v0.61.1/docs/Custom_Pagers.md)).

### Icons and display tweaks

With a Nerd Font installed, `gui.nerdFontsVersion: "3"` enables file icons.
Other useful built-in config options include the file tree, changed-line counts in the Files panel, custom colors, and a detailed commit graph when the terminal supports its symbols ([configuration guide](https://github.com/jesseduffield/lazygit/blob/master/docs/Config.md)).
These are settings rather than third-party extensions.

### Custom commands for external workflows

Custom commands can be scoped to a panel, receive selected file/branch/commit data through templates, prompt for input or confirmation, and run in the terminal or show output in a popup.
They can also be grouped in a menu to avoid filling the keybindings list ([custom-command guide](https://github.com/jesseduffield/lazygit/blob/master/docs/Custom_Command_Keybindings.md)).

The community compendium includes examples for GitHub and GitLab pull-request actions, Gerrit, choosing a remote before pushing, Commitizen, Conventional Commits, Gitmoji, branch cleanup, and launching `tig` or `git difftool` for history and review.
These are recipes to copy into YAML, not separately installed LazyGit packages ([compendium](https://github.com/jesseduffield/lazygit/wiki/Custom-Commands-Compendium)).

Git Town is a notable optional integration for stacked-branch workflows.
Its maintainers publish LazyGit commands for operations such as sync, hack, propose, and undo ([Git Town integration guide](https://www.git-town.com/how-to/lazygit.html)).

### Share project-specific workflows

LazyGit supports repo-specific config at `<repo>/.git/lazygit.yml` and inherited `.lazygit.yml` files in parent directories.
That lets teams ship relevant custom commands without imposing personal UI choices globally ([configuration guide](https://github.com/jesseduffield/lazygit/blob/master/docs/Config.md)).

## Practical shortlist

1. Keep Delta as the default diff renderer, and optionally add Difftastic as a second view for structural changes.
2. Enable Nerd Font icons only if the terminal font supports them.
3. Add a few context-specific commands for workflows not already covered by LazyGit's built-ins, such as a PR check/checkout command, a commit-message helper, or an external review tool.
4. If using Git Town, use its published LazyGit integration rather than creating a separate command set from scratch.
5. Put team-wide commands in repository-specific config and reserve risky cleanup or force-push commands for prompts with explicit confirmation.

The installed version is LazyGit 0.61.1.
Use its versioned docs for config snippets, because upstream `master` has since renamed the pager configuration to diff renderers.
