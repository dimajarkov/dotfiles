{ config, pkgs, user, ... }:

let
  dotfiles = "${config.home.homeDirectory}/.dotfiles";
  backpassCli = pkgs.callPackage ./nix/packages/backpass-cli.nix {};
  piUpstream = pkgs.callPackage ./nix/packages/pi-coding-agent.nix {};
in {
  home.username = user;
  home.homeDirectory = "/Users/${user}";
  home.stateVersion = "24.11";

  home.packages = with pkgs; [
    bash
    backpassCli
    btop
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

    for extension in browser web-fetch; do
      extension_path="${config.home.homeDirectory}/.pi/agent/extensions/$extension"
      extension_source="${dotfiles}/home/.pi/agent/extensions/$extension"

      if [ -L "$extension_path" ] && [ "$(/usr/bin/readlink "$extension_path")" = "$extension_source" ]; then
        migration_stage="$(/usr/bin/mktemp -d "$extension_path.migration.XXXXXX")"
        moved_runtimes=""
        for runtime in node_modules .profile .browsers; do
          if [ -e "$extension_source/$runtime" ]; then
            if /bin/mv -- "$extension_source/$runtime" "$migration_stage/$runtime"; then
              moved_runtimes="$runtime $moved_runtimes"
            else
              for moved_runtime in $moved_runtimes; do
                /bin/mv -- "$migration_stage/$moved_runtime" "$extension_source/$moved_runtime"
              done
              /bin/rmdir -- "$migration_stage"
              false
            fi
          fi
        done
        if ! /bin/rm -- "$extension_path" || ! /bin/mv -- "$migration_stage" "$extension_path"; then
          for moved_runtime in $moved_runtimes; do
            /bin/mv -- "$migration_stage/$moved_runtime" "$extension_source/$moved_runtime"
          done
          /bin/rmdir -- "$migration_stage"
          if [ ! -e "$extension_path" ]; then
            /bin/ln -s -- "$extension_source" "$extension_path"
          fi
          false
        fi
      fi

      if [ -d "$extension_path" ] && [ ! -L "$extension_path" ]; then
        migration_ready=1
        for file in .gitignore README.md index.ts jina-fallback.ts network-serialization.ts response-body.ts package.json package-lock.json; do
          file_path="$extension_path/$file"
          file_source="$extension_source/$file"
          if [ -e "$file_path" ] && [ ! -L "$file_path" ]; then
            if [ ! -f "$file_path" ] || [ ! -f "$file_source" ] || ! /usr/bin/cmp -s "$file_path" "$file_source"; then
              migration_ready=0
            fi
          fi
        done

        if [ "$migration_ready" -eq 1 ]; then
          for file in .gitignore README.md index.ts jina-fallback.ts network-serialization.ts response-body.ts package.json package-lock.json; do
            file_path="$extension_path/$file"
            file_source="$extension_source/$file"
            if [ -f "$file_path" ] && [ ! -L "$file_path" ] && [ -f "$file_source" ] && /usr/bin/cmp -s "$file_path" "$file_source"; then
              /bin/rm -- "$file_path"
            fi
          done
        fi
      fi
    done

    agents_path="${config.home.homeDirectory}/AGENTS.md"
    agents_source="${dotfiles}/home/AGENTS.md"
    if [ -f "$agents_path" ] && [ ! -L "$agents_path" ] && /usr/bin/cmp -s "$agents_path" "$agents_source"; then
      /bin/rm -- "$agents_path"
    fi
  '';

  home.activation.installPiExtensionDependencies = config.lib.dag.entryAfter [ "linkGeneration" ] ''
    export PATH="${pkgs.nodejs_22}/bin:$PATH"

    install_pi_extension_dependencies() {
      extension_path="$1"
      install_scope="all"
      post_install=""
      if [ "$#" -ge 2 ]; then
        install_scope="$2"
      fi
      if [ "$#" -ge 3 ]; then
        post_install="$3"
      fi
      lock_hash="$(${pkgs.coreutils}/bin/sha256sum "$extension_path/package-lock.json" | ${pkgs.coreutils}/bin/cut -d ' ' -f 1)"
      stamp_value="$lock_hash"
      if [ "$install_scope" = "production" ]; then
        stamp_value="production:$lock_hash"
      fi
      if [ -n "$post_install" ]; then
        stamp_value="$post_install:$stamp_value"
      fi
      stamp_path="$extension_path/node_modules/.home-manager-lock-hash"
      if [ ! -f "$stamp_path" ] || [ "$(/bin/cat "$stamp_path")" != "$stamp_value" ]; then
        if [ "$install_scope" = "production" ]; then
          ${pkgs.nodejs_22}/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix "$extension_path"
        elif [ "$install_scope" = "all" ]; then
          ${pkgs.nodejs_22}/bin/npm ci --ignore-scripts --no-audit --no-fund --prefix "$extension_path"
        else
          printf 'Unsupported Pi extension dependency scope: %s\n' "$install_scope" >&2
          false
        fi
        if [ "$post_install" = "effect-tsgo" ]; then
          ${pkgs.nodejs_22}/bin/npm run --prefix "$extension_path" prepare
        elif [ -n "$post_install" ]; then
          printf 'Unsupported Pi extension post-install step: %s\n' "$post_install" >&2
          false
        fi
        printf '%s\n' "$stamp_value" > "$stamp_path"
      fi
    }

    browser_path="${config.home.homeDirectory}/.pi/agent/extensions/browser"
    install_pi_extension_dependencies "$browser_path"

    ask_user_path="${config.home.homeDirectory}/.pi/agent/extensions/ask-user"
    install_pi_extension_dependencies "$ask_user_path"

    file_search_path="${config.home.homeDirectory}/.pi/agent/extensions/file-search"
    file_search_source="${dotfiles}/home/.pi/agent/extensions/file-search"
    install_pi_extension_dependencies "$file_search_path" production
    if [ -L "$file_search_source/node_modules" ]; then
      if [ "$(/usr/bin/readlink "$file_search_source/node_modules")" != "$file_search_path/node_modules" ]; then
        printf 'Unexpected file-search source node_modules link: %s\n' "$file_search_source/node_modules" >&2
        false
      fi
    elif [ -e "$file_search_source/node_modules" ]; then
      printf 'Refusing to replace existing file-search source node_modules: %s\n' "$file_search_source/node_modules" >&2
      false
    else
      /bin/ln -s -- "$file_search_path/node_modules" "$file_search_source/node_modules"
    fi

    install_pi_extension_dependencies "${config.home.homeDirectory}/.pi/agent/extensions/web-fetch"
    install_pi_extension_dependencies "${config.home.homeDirectory}/.pi/agent/extensions/summaries"
    subagents_path="${config.home.homeDirectory}/.pi/agent/extensions/subagents"
    install_pi_extension_dependencies "$subagents_path" all effect-tsgo
    for extension in git-info model-info ui-customization; do
      extension_path="${config.home.homeDirectory}/.pi/agent/extensions/$extension"
      install_pi_extension_dependencies "$extension_path" all effect-tsgo
    done
    PLAYWRIGHT_BROWSERS_PATH="${config.home.homeDirectory}/.pi/agent/extensions/browser/.browsers" \
      ${pkgs.nodejs_22}/bin/node "$browser_path/node_modules/playwright-core/cli.js" install chromium
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
  home.file.".pi/agent/tsconfig.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/tsconfig.json";
  home.file.".pi/agent/agents/Explore.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/agents/Explore.md";
  home.file.".pi/agent/agents/researcher.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/agents/researcher.md";
  home.file.".pi/agent/keybindings.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/keybindings.json";
  home.file.".pi/agent/models.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/models.json";
  home.file.".pi/agent/mcp.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/mcp.json";
  home.file.".pi/agent/skills/web-debug".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/skills/web-debug";
  home.file.".pi/agent/skills/subagents".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/skills/subagents";
  home.file.".pi/agent/themes/catppuccin-latte.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/themes/catppuccin-latte.json";
  home.file.".pi/agent/themes/catppuccin-mocha.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/themes/catppuccin-mocha.json";
  home.file.".pi/agent/extensions/subagents".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/subagents";
  home.file.".pi/agent/extensions/shared/tool-call-timeout.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/shared/tool-call-timeout.ts";
  home.file.".pi/agent/extensions/shared/dashboard-state.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/shared/dashboard-state.ts";
  home.file.".pi/agent/extensions/shared/package.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/shared/package.json";
  home.file.".pi/agent/extensions/git-info".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/git-info";
  home.file.".pi/agent/extensions/model-info".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/model-info";
  home.file.".pi/agent/extensions/ui-customization".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/ui-customization";
  home.file.".pi/agent/themes/prime.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/themes/prime.json";
  home.file.".pi/agent/themes/github-dark-default.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/themes/github-dark-default.json";
  home.file.".pi/agent/extensions/fullscreen-navigation.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/fullscreen-navigation.ts";
  home.file.".pi/agent/extensions/ask-user/index.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/ask-user/index.ts";
  home.file.".pi/agent/extensions/ask-user/prompt.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/ask-user/prompt.ts";
  home.file.".pi/agent/extensions/ask-user/package.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/ask-user/package.json";
  home.file.".pi/agent/extensions/ask-user/package-lock.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/ask-user/package-lock.json";
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
  home.file.".pi/agent/extensions/lib/credential-safety.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/lib/credential-safety.ts";
  home.file.".pi/agent/extensions/lib/terminal-safety.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/lib/terminal-safety.ts";
  home.file.".pi/agent/extensions/browser/.gitignore".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/browser/.gitignore";
  home.file.".pi/agent/extensions/browser/README.md".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/browser/README.md";
  home.file.".pi/agent/extensions/browser/index.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/browser/index.ts";
  home.file.".pi/agent/extensions/browser/network-serialization.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/browser/network-serialization.ts";
  home.file.".pi/agent/extensions/browser/package.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/browser/package.json";
  home.file.".pi/agent/extensions/browser/package-lock.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/browser/package-lock.json";
  home.file.".pi/agent/extensions/file-search/.gitignore".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/file-search/.gitignore";
  home.file.".pi/agent/extensions/file-search/index.spec.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/file-search/index.spec.ts";
  home.file.".pi/agent/extensions/file-search/index.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/file-search/index.ts";
  home.file.".pi/agent/extensions/file-search/package-lock.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/file-search/package-lock.json";
  home.file.".pi/agent/extensions/file-search/package.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/file-search/package.json";
  home.file.".pi/agent/extensions/file-search/src/args.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/file-search/src/args.ts";
  home.file.".pi/agent/extensions/file-search/src/binaries.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/file-search/src/binaries.ts";
  home.file.".pi/agent/extensions/file-search/src/output.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/file-search/src/output.ts";
  home.file.".pi/agent/extensions/file-search/src/process.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/file-search/src/process.ts";
  home.file.".pi/agent/extensions/file-search/src/prompt.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/file-search/src/prompt.ts";
  home.file.".pi/agent/extensions/file-search/tsconfig.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/file-search/tsconfig.json";
  home.file.".pi/agent/extensions/web-fetch/.gitignore".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/web-fetch/.gitignore";
  home.file.".pi/agent/extensions/web-fetch/index.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/web-fetch/index.ts";
  home.file.".pi/agent/extensions/web-fetch/jina-fallback.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/web-fetch/jina-fallback.ts";
  home.file.".pi/agent/extensions/web-fetch/response-body.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/web-fetch/response-body.ts";
  home.file.".pi/agent/extensions/web-fetch/package.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/web-fetch/package.json";
  home.file.".pi/agent/extensions/web-fetch/package-lock.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/web-fetch/package-lock.json";
  home.file.".pi/agent/extensions/summaries/.gitignore".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/summaries/.gitignore";
  home.file.".pi/agent/extensions/summaries/index.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/summaries/index.ts";
  home.file.".pi/agent/extensions/summaries/package.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/summaries/package.json";
  home.file.".pi/agent/extensions/summaries/package-lock.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/summaries/package-lock.json";
  home.file.".pi/agent/extensions/summaries/tsconfig.json".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/summaries/tsconfig.json";
  home.file.".pi/agent/extensions/summaries/src/config.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/summaries/src/config.ts";
  home.file.".pi/agent/extensions/summaries/src/prompt.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/summaries/src/prompt.ts";
  home.file.".pi/agent/extensions/summaries/src/summarizer.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/summaries/src/summarizer.ts";
  home.file.".pi/agent/extensions/summaries/src/transcript.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/summaries/src/transcript.ts";
  home.file.".pi/agent/extensions/summaries/src/ui.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/summaries/src/ui.ts";
  home.file.".pi/agent/extensions/copy-all/index.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/copy-all/index.ts";
  home.file.".pi/agent/extensions/gpt-5-6-only.ts".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.pi/agent/extensions/gpt-5-6-only.ts";
  home.file.".hammerspoon/init.lua".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.hammerspoon/init.lua";
  home.file.".hammerspoon/reminders-vim.lua".source =
    config.lib.file.mkOutOfStoreSymlink "${dotfiles}/home/.hammerspoon/reminders-vim.lua";
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
