{ config, pkgs, user, ... }:

let
  dotfiles = "${config.home.homeDirectory}/.dotfiles";
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
    ripgrep
    ruff
    starship
    tree-sitter
    ty
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
    autosuggestion.enable = true;
    syntaxHighlighting.enable = true;
    history = {
      size = 10000;
      save = 10000;
      ignoreDups = true;
      share = true;
    };
    initContent = ''
      bindkey '^f' autosuggest-accept
      eval "$(zoxide init zsh)"

      awt() {
        local root="$HOME/dev/arena"
        local main="$root/arena-crm"
        local worktrees="$root/arena-crm.worktrees"
        local choice

        if ! [[ -d "$main" || -d "$worktrees" ]]; then
          print -u2 "awt: no Arena CRM checkouts found under $root"
          return 1
        fi

        local -a choices
        [[ -d "$main" ]] && choices+=("$main")
        [[ -d "$worktrees" ]] && choices+=("$worktrees"/*(N/))
        (( ''${#choices[@]} )) || return 1

        if (( $+commands[fzf] )); then
          choice=$(printf '%s\n' "''${choices[@]}" | sort | fzf --prompt='arena worktree> ' --height=40% --reverse) || return
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

  home.file.".config/gh/config.yml".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/gh/config.yml";
  home.file.".config/wezterm".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/wezterm";
  home.file.".config/nvim".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/nvim";
  home.file.".config/herdr".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.config/herdr";
  home.file.".claude/CLAUDE.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/AGENTS.md";
  home.file.".codex/AGENTS.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/AGENTS.md";
}
