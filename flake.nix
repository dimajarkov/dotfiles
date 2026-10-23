{
  description = "Dmitri's macOS system and user configuration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
    nix-darwin.url = "github:nix-darwin/nix-darwin/nix-darwin-26.05";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";
    home-manager.url = "github:nix-community/home-manager/release-26.05";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
    nix-homebrew.url = "github:zhaofengli/nix-homebrew";
    homebrew-runtime = {
      url = "github:Homebrew/brew/7.0.9";
      flake = false;
    };
    # Keep the review host and its Bun dependency recipe on the installed release.
    hunk-upstream.url = "github:modem-dev/hunk/7991d3034af1d2116e9c77db31265e409a73bd9f";
    # Personal fork: physical identity, guarded repair and launch admission.
    treehouse-owned = {
      url = "github:dimajarkov/treehouse/f0f75db0941b970e830e75e4dbfd197646476d06";
      flake = false;
    };
  };

  outputs = inputs@{ self, nix-darwin, nix-homebrew, home-manager, nixpkgs, ... }:
    let
      user = "dmitrijarkov";
      system = "aarch64-darwin";
      pkgs = import nixpkgs { inherit system; };
      bashDarwin = pkgs.callPackage ./nix/packages/bash-darwin-pipes.nix { interactive = false; };
      bashDarwinInteractive = pkgs.callPackage ./nix/packages/bash-darwin-pipes.nix {};
      hunkReviewHost = import ./nix/packages/hunk-review-host.nix {
        upstreamHost = inputs.hunk-upstream.packages.${system}.hunk;
        inherit (pkgs) python3;
      };
      hunkTurnReviewAssets = pkgs.callPackage ./nix/packages/hunk-turn-review.nix {
        inherit pkgs hunkReviewHost piCodingAgent bashDarwin;
        bun2nix = inputs.hunk-upstream.inputs.bun2nix.packages.${system}.default;
      };
      piCodingAgent = pkgs.callPackage ./nix/packages/pi-coding-agent.nix {};
      treehouseOwned = pkgs.callPackage ./nix/packages/treehouse-owned.nix {
        source = inputs.treehouse-owned;
      };
      hunkTurnReviewProfile = import ./nix/modules/hunk-turn-review-profile.nix {
        inherit pkgs hunkReviewHost hunkReviewHostTypes hunkTurnReviewAssets piCodingAgent bashDarwin bashDarwinInteractive;
      };
      hunkReviewHostTypes = pkgs.callPackage ./nix/packages/hunk-review-host-types.nix {
        inherit pkgs hunkReviewHost;
      };
    in {
      packages.${system} = {
        homebrew-runtime-activation = pkgs.writeShellScriptBin "activate-homebrew-runtime" ''
          if [ "$(/usr/bin/id -u)" -ne 0 ]; then
            echo "Run this Nix-owned Homebrew setup with sudo." >&2
            exit 1
          fi
          ${self.darwinConfigurations.mac.config.system.activationScripts.setup-homebrew.text}
        '';
        herdr-package-test = pkgs.writeShellScriptBin "herdr-package-test" ''
          export HOMEBREW_DEVELOPER=1 HOMEBREW_TESTS=1 HOMEBREW_NO_AUTO_UPDATE=1
          exec /opt/homebrew/bin/brew ruby -e '
            $LOAD_PATH.unshift(ARGV.shift)
            require "formulary"
            require "formula_assertions"
            formula = Formulary.factory("dimajarkov/dotfiles/herdr")
            formula.extend(Homebrew::Assertions)
            formula.run_test
            puts "Installed formula assertions passed: #{formula.assertions}"
          ' ${pkgs.rubyPackages.minitest}/${pkgs.ruby.gemPath}/gems/minitest-${pkgs.rubyPackages.minitest.version}/lib
        '';
        bash-darwin-pipes = bashDarwin;
        bash-darwin-pipes-interactive = bashDarwinInteractive;
        hunk-review-host = hunkReviewHost;
        hunk-review-host-types = hunkReviewHostTypes;
        hunk-turn-review-assets = hunkTurnReviewAssets;
        hunk-turn-review = hunkTurnReviewProfile;
        pi-coding-agent = piCodingAgent;
        treehouse-owned = treehouseOwned;
      };
      apps.${system} = {
        treehouse-owned-install = {
          type = "app";
          program = "${treehouseOwned}/bin/treehouse-owned-install";
          meta.description = "Explicit guarded update of the existing regular-file Treehouse installation";
        };
        hunk-turn-review-install = {
          type = "app";
          program = "${hunkTurnReviewProfile}/bin/hunk-turn-review-install";
          meta.description = "Explicit feature-only Hunk review activation and rollback";
        };
        hunk-review-host-types = {
          type = "app";
          program = "${hunkReviewHostTypes}/bin/hunk-review-host-types";
          meta.description = "Materialize the matching packaged public Hunk declarations";
        };
      };
      checks.${system} = {
        treehouse-owned = treehouseOwned;
        treehouse-owned-installation = pkgs.runCommand "treehouse-owned-installation-check" {} ''
          export TREEHOUSE_INSTALLER=${treehouseOwned}/share/treehouse-owned/install.py
          export TREEHOUSE_DOTFILES_FLAKE_LOCK=${./flake.lock}
          export TREEHOUSE_ARTIFACT_MANIFEST=${treehouseOwned}/share/treehouse-owned/manifest.json
          ${pkgs.python3}/bin/python3 ${./nix/tests/treehouse-owned-installation.py}
          touch "$out"
        '';
        sketchybar-configuration = pkgs.runCommand "sketchybar-configuration-check" {
          nativeBuildInputs = [ pkgs.python3 pkgs.ruff ];
        } ''
          export PYTHONDONTWRITEBYTECODE=1
          export SKETCHYBAR_APP_FONT_MAP=${pkgs.sketchybar-app-font}/lib/sketchybar-app-font/icon_map.lua
          export SKETCHYBAR_APP_FONT_FILE=${pkgs.sketchybar-app-font}/share/fonts/truetype/sketchybar-app-font.ttf
          mkdir -p home/.config tests
          cp -R ${./home/.config/sketchybar} home/.config/sketchybar
          cp ${./tests/sketchybar.py} tests/sketchybar.py
          cp ${./tests/sketchybar-metrics.py} tests/sketchybar-metrics.py
          cp ${./tests/aerospace-sketchybar.py} tests/aerospace-sketchybar.py
          cp ${./home/.aerospace.toml} home/.aerospace.toml
          cp ${./tests/sketchybar-workspaces.py} tests/sketchybar-workspaces.py
          cp ${./tests/sketchybar-stability.py} tests/sketchybar-stability.py
          # Lint only: the opt-in latency probe deliberately switches desktops.
          cp ${./tests/sketchybar-latency.py} tests/sketchybar-latency.py
          cp ${./tests/sketchybar-live.py} tests/sketchybar-live.py
          python3 tests/sketchybar.py
          python3 tests/sketchybar-metrics.py
          python3 tests/aerospace-sketchybar.py
          python3 tests/sketchybar-workspaces.py
          ruff check home/.config/sketchybar/plugins/*.py tests/sketchybar*.py tests/aerospace-sketchybar.py
          ruff format --check home/.config/sketchybar/plugins/*.py tests/sketchybar*.py tests/aerospace-sketchybar.py
          touch "$out"
        '';
        bash-darwin-source = import ./nix/tests/bash-darwin-pipes.nix {
          inherit pkgs bashDarwin bashDarwinInteractive;
        };
        bash-home-wiring = let
          standalone = home-manager.lib.homeManagerConfiguration {
            inherit pkgs;
            modules = [ ./home.nix ];
            extraSpecialArgs = { inherit user; };
          };
          featurePackages = self.darwinConfigurations.mac.config.home-manager.users.${user}.home.packages;
        in
          assert builtins.elem bashDarwinInteractive standalone.config.home.packages;
          assert !(builtins.elem pkgs.bash standalone.config.home.packages);
          assert !(builtins.elem hunkTurnReviewProfile featurePackages);
          assert builtins.elem bashDarwinInteractive featurePackages;
          assert !(builtins.elem pkgs.bash featurePackages);
          pkgs.runCommand "bash-home-wiring-check" {} ''touch "$out"'';
        bash-heredoc = pkgs.runCommand "bash-darwin-heredoc-check" {} ''
          ${pkgs.python3}/bin/python3 ${./nix/tests/bash-heredoc.py} \
            ${bashDarwin}/bin/bash ${bashDarwinInteractive}/bin/bash \
            --cat ${pkgs.coreutils}/bin/cat --expected-version 5.3.16
          touch "$out"
        '';
        bash-heredoc-dynamic = let
          # Keep the old installed binary's 65536-byte compile-time assumption
          # in this test-only build, even when configure measures only 512.
          dynamic = bashDarwin.overrideAttrs (old: {
            env = (old.env or {}) // {
              NIX_CFLAGS_COMPILE = bashDarwin.drvAttrs.NIX_CFLAGS_COMPILE + " -DHEREDOC_PIPESIZE=65536";
            };
            postFixup = old.postFixup + ''
              printf '%s\n' 'Regression only: -DHEREDOC_PIPESIZE=65536' \
                >> "$out/nix-support/bash-darwin-pipes/build-config.txt"
            '';
          });
        in pkgs.runCommand "bash-darwin-dynamic-pipe-check" {} ''
          ${pkgs.python3}/bin/python3 ${./nix/tests/bash-heredoc.py} \
            ${dynamic}/bin/bash --cat ${pkgs.coreutils}/bin/cat --expected-version 5.3.16
          touch "$out"
        '';
        hunk-review-host = hunkReviewHost;
        hunk-turn-review-artifact = hunkTurnReviewProfile;
        hunk-turn-review-installation = pkgs.runCommand "hunk-turn-review-installation-check" {} ''
          export HUNK_REVIEW_TEST_PROFILE=${hunkTurnReviewProfile}
          export HUNK_REVIEW_TEST_INSTALLER=${hunkTurnReviewProfile}/share/hunk-turn-review/install.py
          export HUNK_REVIEW_TEST_NIX_STORE=${pkgs.coreutils}/bin/true
          export HUNK_REVIEW_TEST_ZSH=${pkgs.zsh}/bin/zsh
          export HUNK_REVIEW_TEST_PI=${piCodingAgent}/bin/pi
          ${pkgs.python3}/bin/python3 ${./nix/tests/hunk-turn-review-installation.py}
          touch "$out"
        '';
        hunk-turn-review-codex-launch = pkgs.runCommand "hunk-turn-review-codex-launch-check" {
          nativeBuildInputs = [ pkgs.git ];
        } ''
          export HUNK_REVIEW_TEST_LAUNCHER=${./nix/runtime/hunk-turn-review-codex.py}
          ${pkgs.python3}/bin/python3 ${./nix/tests/hunk-turn-review-codex-launch.py}
          touch "$out"
        '';
      };

      darwinConfigurations."mac" = nix-darwin.lib.darwinSystem {
        specialArgs = { inherit user; };
        modules = [
          ./configuration.nix
          nix-homebrew.darwinModules.nix-homebrew
          home-manager.darwinModules.home-manager
          {
            nix-homebrew.package = pkgs.runCommand "brew-7.0.9" {
              version = "7.0.9";
            } ''
              cp -R ${inputs.homebrew-runtime} "$out"
              chmod u+w "$out/Library/Homebrew" "$out/Library/Homebrew/brew.sh"
              # Homebrew 7 moved version discovery into a helper that needs Git.
              substituteInPlace "$out/Library/Homebrew/brew.sh" \
                --replace-fail 'set-homebrew-version-from-git' 'HOMEBREW_VERSION="7.0.9"'
            '';
            home-manager.useGlobalPkgs = true;
            home-manager.useUserPackages = true;
            home-manager.backupFileExtension = "hm-backup";
            home-manager.extraSpecialArgs = { inherit user bashDarwinInteractive; };
            home-manager.users.${user} = import ./home.nix;
          }
        ];
      };
    };
}
