{ config, pkgs, user, ... }:

let
  dotfiles = "${config.home.homeDirectory}/.dotfiles";
  piComposioExtension = pkgs.buildNpmPackage {
    pname = "pi-composio-extension";
    version = "1.0.0";
    src = ./home/.pi/agent/extensions/composio/runtime;
    npmDepsHash = "sha256-wtcBCX3Prxlxh8xkNiMgn1yZdVv7lyX1rgbLQhGNLuU=";
    npmFlags = [ "--legacy-peer-deps" ];
    dontNpmBuild = true;
    installPhase = ''
      mkdir -p "$out"
      cp ${./home/.pi/agent/extensions/composio/index.ts} "$out/index.ts"
      cp ${./home/.pi/agent/extensions/composio/auth.ts} "$out/auth.ts"
      cp ${./home/.pi/agent/extensions/composio/config.ts} "$out/config.ts"
      cp ${./home/.pi/agent/extensions/composio/output.ts} "$out/output.ts"
      cp ${./home/.pi/agent/extensions/composio/README.md} "$out/README.md"
      cp package.json package-lock.json "$out/"
      cp -R node_modules "$out/"
    '';
  };
  piIpythonExtension = pkgs.buildNpmPackage {
    pname = "pi-ipython-primary-tool";
    version = "1.0.0";
    src = ./home/.pi/agent/extensions/ipython/runtime;
    npmDepsHash = "sha256-/ASGFC5XEozMZBJonypYuH0WxfeZnnzyp7qaCc0nsY0=";
    dontNpmBuild = true;
    installPhase = ''
      mkdir -p "$out"
      cp ${./home/.pi/agent/extensions/ipython/index.ts} "$out/index.ts"
      cp ${./home/.pi/agent/extensions/ipython/bootstrap.ts} "$out/bootstrap.ts"
      cp ${./home/.pi/agent/extensions/ipython/kernel.ts} "$out/kernel.ts"
      cp ${./home/.pi/agent/extensions/ipython/fork-server.ts} "$out/fork-server.ts"
      cp ${./home/.pi/agent/extensions/ipython/runtime.ts} "$out/runtime.ts"
      cp ${./home/.pi/agent/extensions/ipython/python-skills.ts} "$out/python-skills.ts"
      cp -R ${./home/.pi/agent/extensions/ipython/python-skills} "$out/python-skills"
      cp ${./home/.pi/agent/extensions/ipython/state-snapshot.ts} "$out/state-snapshot.ts"
      cp ${./home/.pi/agent/extensions/ipython/code-preview.ts} "$out/code-preview.ts"
      cp ${./home/.pi/agent/extensions/ipython/ipython-cell-code.ts} "$out/ipython-cell-code.ts"
      cp ${./home/.pi/agent/extensions/ipython/renderer.ts} "$out/renderer.ts"
      cp ${./home/.pi/agent/extensions/ipython/README.md} "$out/README.md"
      cp ${./home/.pi/agent/extensions/ipython/UPSTREAM_LICENSE} "$out/UPSTREAM_LICENSE"
      cp ${./home/.pi/agent/extensions/ipython/requirements.in} "$out/requirements.in"
      cp ${./home/.pi/agent/extensions/ipython/requirements.lock} "$out/requirements.lock"
      cp package.json package-lock.json "$out/"
      cp -R node_modules "$out/"
    '';
  };
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
    nodejs_24
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

  home.file.".pi/agent/settings.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/settings.json";
  home.file.".pi/agent/models.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/models.json";
  home.file.".pi/agent/mcp.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/mcp.json";
  home.file.".pi/agent/openai-server-compaction.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/openai-server-compaction.json";
  home.file.".pi/agent/themes/catppuccin-latte.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/themes/catppuccin-latte.json";
  home.file.".pi/agent/themes/catppuccin-mocha.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/themes/catppuccin-mocha.json";
  home.file.".pi/agent/themes/prime.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/themes/prime.json";
  home.file.".pi/agent/extensions/status-line.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/status-line.ts";
  home.file.".pi/agent/extensions/prime-style.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/prime-style.ts";
  home.file.".pi/agent/extensions/prime-parity.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/prime-parity.ts";
  home.file.".pi/agent/extensions/terminal-status-title.js".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/terminal-status-title.js";
  home.file.".pi/agent/extensions/mac-system-theme.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/mac-system-theme.ts";
  home.file.".pi/agent/extensions/goal".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/goal";
  home.file.".pi/agent/extensions/supabase-keychain".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/supabase-keychain";
  home.file.".pi/agent/extensions/composio".source = piComposioExtension;
  home.file.".pi/agent/extensions/ipython".source = piIpythonExtension;
  home.file.".pi/agent/skills/attach-image".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/skills/attach-image";
  home.file.".pi/agent/skills/edit".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/skills/edit";
  home.file.".pi/agent/skills/refine".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/skills/refine";
  home.file.".config/gh/config.yml".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/gh/config.yml";
  home.file.".config/wezterm".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/wezterm";
  home.file.".config/nvim".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/nvim";
  home.file.".config/herdr".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/herdr";
  home.file.".agents/skills/treehouse-herdr-feature-runtime".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.agents/skills/treehouse-herdr-feature-runtime";
  home.file.".claude/settings.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.claude/settings.json";
  home.file.".claude/CLAUDE.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/AGENTS.md";
  home.file.".codex/AGENTS.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.codex/AGENTS.md";
}
