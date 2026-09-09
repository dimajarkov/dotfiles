{ config, pkgs, user, ... }:

let
  dotfiles = "${config.home.homeDirectory}/.dotfiles";
  piUpstream = pkgs.callPackage ./nix/packages/pi-coding-agent.nix {};
  piSubagentExtension = "${dotfiles}/home/.pi/agent/extensions/subagent";
in {
  home.username = user;
  home.homeDirectory = "/Users/${user}";
  home.stateVersion = "24.11";

  home.packages = with pkgs; [
    bash
    codebook
    python313Packages.debugpy
    entr
    fd
    fzf
    git-lfs
    jq
    lazygit
    lua-language-server
    neovim
    nerd-fonts.hack
    nodejs_22
    ripgrep
    ruff
    starship
    tree-sitter
    ty
    uv
    zoxide
  ];

  home.sessionPath = [
    "/opt/homebrew/bin"
    "${config.home.homeDirectory}/.npm-global/bin"
    "${config.home.homeDirectory}/.bun/bin"
    "${config.home.homeDirectory}/.local/bin"
  ];
  home.sessionVariables.EDITOR = "nvim";
  fonts.fontconfig.enable = true;

  programs.git = {
    enable = true;
    lfs.enable = true;
    settings = {
      user.name = "dimajarkov";
      user.email = "dmitri@arenacrm.com";
      color.ui = true;
      core.editor = "nvim";
      pull.rebase = true;
      push.autoSetupRemote = true;
      rebase.updateRefs = true;
    };
    ignores = [
      "**/.claude/settings.local.json"
    ];
  };

  programs.zsh = {
    enable = true;
    enableCompletion = false;
    envExtra = ''
      export NOSYSZSHRC=1
    '';
    autosuggestion.enable = true;
    syntaxHighlighting.enable = true;
    history = {
      size = 10000;
      save = 10000;
      ignoreDups = true;
      share = true;
    };
    initContent = ''
      mkdir -p "''${XDG_CACHE_HOME:-$HOME/.cache}/zsh"
      autoload -U compinit
      compinit -d "''${XDG_CACHE_HOME:-$HOME/.cache}/zsh/zcompdump"

      bindkey '^f' autosuggest-accept
      eval "$(zoxide init zsh)"

      awt() {
        local root="$HOME/dev/arena"
        local main="$root/arena-crm"
        local choice

        if [[ ! -d "$main" ]]; then
          print -u2 "awt: Arena CRM source checkout not found at $main"
          return 1
        fi

        local -a choices
        choices+=("$main")
        if (( $+commands[treehouse] && $+commands[jq] )); then
          while IFS= read -r worktree; do
            [[ -d "$worktree" ]] && choices+=("$worktree")
          done < <(cd -- "$main" && treehouse status --json 2>/dev/null | jq -r '.[].path')
        fi

        if (( $+commands[fzf] )); then
          choice=$(printf '%s\n' "''${choices[@]}" | awk '!seen[$0]++' | fzf --prompt='arena worktree> ' --height=40% --reverse) || return
        else
          select choice in "''${choices[@]}"; do
            [[ -n "$choice" ]] && break
          done
        fi
        [[ -n "$choice" ]] && cd -- "$choice"
      }

      awstack() {
        bun run dev:worktree -- --apps website,dash,os,api,webhooks,trigger
      }

      awseed() {
        bun run supabase:worktree seed-sean --login-only
      }

      awstatus() {
        bun run supabase:worktree status
      }
    '';
    shellAliases = {
      ".." = "cd ..";
      add = "git add .";
      amend = "git commit --amend";
      h = "herdr";
      ha = "herdr";
      hl = "herdr session list";
      hn = "herdr --session";
      m = "git switch main";
      mst = "git switch master";
      pull = "git pull";
      push = "git push";
      pushf = "git push --force";
      rebasem = "git rebase -i main";
      rebasemst = "git rebase -i master";
      rebuild = "darwin-rebuild switch --flake ~/dotfiles#mac";
      reset = "git reset --soft HEAD^";
      cc = "claude --dangerously-skip-permissions";
      co = "codex --full-auto";
    };
  };

  programs.starship = {
    enable = true;
    settings = {
      add_newline = false;
      format = "$directory$git_branch$git_status$cmd_duration$line_break$character";
      character = {
        success_symbol = "[❯](purple)";
        error_symbol = "[❯](red)";
      };
      cmd_duration.format = "[$duration]($style) ";
    };
  };

  home.activation.migrateLegacyPiFiles = config.lib.dag.entryBefore [ "checkFilesChanged" "checkLinkTargets" ] ''
    mcp_path="${config.home.homeDirectory}/.pi/agent/mcp.json"
    mcp_source="${dotfiles}/home/.pi/agent/mcp.json"
    if [ -f "$mcp_path" ] && [ ! -L "$mcp_path" ] && /usr/bin/cmp -s "$mcp_path" "$mcp_source"; then
      /bin/rm -- "$mcp_path"
    fi

    custom_header_path="${config.home.homeDirectory}/.pi/agent/extensions/custom-header.ts"
    custom_header_source="${dotfiles}/home/.pi/agent/extensions/custom-header.ts"
    if [ -f "$custom_header_path" ] && [ ! -L "$custom_header_path" ] && /usr/bin/cmp -s "$custom_header_path" "$custom_header_source"; then
      /bin/rm -- "$custom_header_path"
    fi

    for extension in browser web-fetch; do
      extension_path="${config.home.homeDirectory}/.pi/agent/extensions/$extension"
      extension_source="${dotfiles}/home/.pi/agent/extensions/$extension"
      if [ -d "$extension_path" ] && [ ! -L "$extension_path" ]; then
        for runtime in node_modules .profile; do
          runtime_path="$extension_path/$runtime"
          runtime_source="$extension_source/$runtime"
          if [ -e "$runtime_path" ] && [ ! -e "$runtime_source" ]; then
            /bin/mv -- "$runtime_path" "$runtime_source"
          fi
        done

        for file in README.md index.ts package.json package-lock.json; do
          file_path="$extension_path/$file"
          file_source="$extension_source/$file"
          if [ -f "$file_path" ] && [ -f "$file_source" ] && /usr/bin/cmp -s "$file_path" "$file_source"; then
            /bin/rm -- "$file_path"
          fi
        done

        if [ -z "$(/usr/bin/find "$extension_path" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
          /bin/rmdir -- "$extension_path"
        fi
      fi
    done

    agents_path="${config.home.homeDirectory}/AGENTS.md"
    agents_source="${dotfiles}/home/AGENTS.md"
    if [ -f "$agents_path" ] && [ ! -L "$agents_path" ] && /usr/bin/cmp -s "$agents_path" "$agents_source"; then
      /bin/rm -- "$agents_path"
    fi
  '';

  home.activation.migrateLegacyHammerspoonConfig = config.lib.dag.entryBefore [ "checkFilesChanged" "checkLinkTargets" ] ''
    config_path="${config.home.homeDirectory}/.hammerspoon/init.lua"
    config_source="${dotfiles}/home/.hammerspoon/init.lua"
    if [ -f "$config_path" ] && [ ! -L "$config_path" ] && /usr/bin/cmp -s "$config_path" "$config_source"; then
      /bin/rm -- "$config_path"
    fi
  '';

  home.file.".local/bin/pi".source = piUpstream + "/bin/pi";
  home.file.".local/bin/owc-container-ready".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.local/bin/owc-container-ready";
  home.file.".local/bin/docker".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.local/bin/docker";
  home.file.".local/bin/docker-compose".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.local/bin/docker-compose";
  home.file.".local/bin/docker-start".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.local/bin/docker-start";
  home.file.".local/bin/docker-stop".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.local/bin/docker-stop";

  home.file.".pi/agent/settings.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/settings.json";
  home.file.".pi/agent/models.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/models.json";
  home.file.".pi/agent/mcp.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/mcp.json";
  home.file.".pi/agent/skills/web-debug".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/skills/web-debug";
  home.file.".pi/agent/themes/catppuccin-latte.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/themes/catppuccin-latte.json";
  home.file.".pi/agent/themes/catppuccin-mocha.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/themes/catppuccin-mocha.json";
  home.file.".pi/agent/extensions/status-line.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/status-line.ts";
  home.file.".pi/agent/themes/prime.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/themes/prime.json";
  home.file.".pi/agent/extensions/fullscreen-navigation.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/fullscreen-navigation.ts";
  home.file.".pi/agent/extensions/prime-style.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/prime-style.ts";
  home.file.".pi/agent/extensions/prime-parity.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/prime-parity.ts";
  home.file.".pi/agent/extensions/prompt-snippets".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/prompt-snippets";
  home.file.".pi/agent/extensions/herdr-pane-name".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/herdr-pane-name";
  home.file.".pi/agent/extensions/terminal-status-title.js".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/terminal-status-title.js";
  home.file.".pi/agent/extensions/mac-system-theme.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/mac-system-theme.ts";
  home.file.".pi/agent/extensions/supabase-keychain".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/supabase-keychain";
  home.file.".pi/agent/extensions/lib/herdr-blocked.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/lib/herdr-blocked.ts";
  home.file.".pi/agent/extensions/subagent".source =
    config.lib.file.mkOutOfStoreSymlink piSubagentExtension;
  home.file.".pi/agent/extensions/browser".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/browser";
  home.file.".pi/agent/extensions/web-fetch".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/web-fetch";
  home.file.".pi/agent/extensions/custom-header.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/custom-header.ts";
  home.file.".pi/agent/agents/planner.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/agents/planner.md";
  home.file.".pi/agent/agents/researcher.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/agents/researcher.md";
  home.file.".pi/agent/agents/reviewer.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/agents/reviewer.md";
  home.file.".pi/agent/agents/scout.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/agents/scout.md";
  home.file.".pi/agent/agents/worker.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/agents/worker.md";
  home.file.".pi/agent/prompts/implement-and-review.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/prompts/implement-and-review.md";
  home.file.".pi/agent/prompts/implement.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/prompts/implement.md";
  home.file.".pi/agent/prompts/scout-and-plan.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/prompts/scout-and-plan.md";
  home.file.".hammerspoon/init.lua".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.hammerspoon/init.lua";
  home.file.".config/gh/config.yml".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/gh/config.yml";
  home.file.".config/wezterm".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/wezterm";
  home.file.".config/nvim".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/nvim";
  home.file.".config/herdr".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/herdr";
  home.file."AGENTS.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/AGENTS.md";
  home.file.".agents/AGENTS.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/AGENTS.md";
  home.file.".agents/skills/one-bin".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.agents/skills/one-bin";
  home.file.".pi/agent/skills/one-bin".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.agents/skills/one-bin";
  home.file.".local/bin/one-bin".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.agents/skills/one-bin/scripts/one-bin.mjs";
  home.file.".claude/settings.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.claude/settings.json";
  home.file.".claude/CLAUDE.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/AGENTS.md";
  home.file.".codex/AGENTS.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.codex/AGENTS.md";
  home.file."OPINIONS.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/OPINIONS.md";
}
