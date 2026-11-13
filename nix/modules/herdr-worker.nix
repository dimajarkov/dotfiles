{ config, lib, pkgs, ... }:

let
  profile = "${config.home.homeDirectory}/.local/state/nix/profiles/dotfiles";
  desktopFiles = [
    ".aerospace.toml"
    ".hammerspoon/init.lua"
    ".config/sketchybar"
    ".config/wezterm"
    ".config/herdr"
    "Library/Fonts/sketchybar-app-font.ttf"
    ".local/share/sketchybar/icon_map.lua"
    ".local/bin/owc-container-ready"
    ".local/bin/docker"
    ".local/bin/docker-compose"
    ".local/bin/docker-start"
    ".local/bin/docker-stop"
    ".local/bin/orb"
    ".local/bin/orbctl"
    ".claude/settings.json"
    ".claude/CLAUDE.md"
    ".claude/skills/browser-routing"
  ];
in {
  imports = [ ../../home.nix ];
  disabledModules = [ ./chrome-for-testing.nix ];

  programs.sketchybar.enable = lib.mkForce false;
  launchd.agents = lib.mkForce {};
  home.activation.sketchybarLogDirectory = lib.mkForce (lib.hm.dag.entryAfter [ "writeBoundary" ] "");
  home.activation.migrateLegacyHammerspoonConfig = lib.mkForce (lib.hm.dag.entryAfter [ "writeBoundary" ] "");
  home.file = lib.genAttrs desktopFiles (_: { enable = false; }) // {
    ".config/herdr/config.toml".source = config.lib.file.mkOutOfStoreSymlink
      "${config.home.homeDirectory}/.dotfiles/home/.config/herdr/config.toml";
  };

  # Preserve the remote account's identity, credentials, and existing Nix profile.
  programs.git.settings.user = lib.mkForce {};
  programs.git.settings.credential = lib.mkForce {};
  home.packages = [ (pkgs.callPackage ../packages/herdr-worker.nix {}) ];
  home.sessionPath = lib.mkBefore [ "${profile}/bin" ];
  # Homebrew belongs to Yuri's desktop user, so its completions are untrusted here.
  programs.zsh.initContent = lib.mkBefore ''
    fpath=("''${(@)fpath:#/opt/homebrew/*}")
  '';
  home.activation.installPackages = lib.mkForce (lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    run mkdir -p "$(dirname '${profile}')"
    run nix-env --profile '${profile}' --set ${config.home.path}
  '');
  # Pi resolves linked extension imports from the source file's real directory.
  home.activation.workerWebFetchModules = lib.hm.dag.entryAfter [ "installPiExtensionDependencies" ] ''
    source_modules="${config.home.homeDirectory}/.dotfiles/home/.pi/agent/extensions/web-fetch/node_modules"
    runtime_modules="${config.home.homeDirectory}/.pi/agent/extensions/web-fetch/node_modules"
    if [ -L "$source_modules" ] && [ "$(readlink "$source_modules")" = "$runtime_modules" ]; then
      :
    elif [ -e "$source_modules" ] || [ -L "$source_modules" ]; then
      echo "Refusing to replace existing web-fetch source dependencies: $source_modules" >&2
      exit 1
    else
      run ln -s "$runtime_modules" "$source_modules"
    fi
  '';
  programs.zsh.shellAliases.rebuild = lib.mkForce "nix build path:$HOME/.dotfiles#homeConfigurations.ci-runner.activationPackage -o $HOME/.local/state/dotfiles-generation && $HOME/.local/state/dotfiles-generation/activate";
}
