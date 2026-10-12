{ pkgs, hunkReviewHost, hunkReviewHostTypes, hunkTurnReviewAssets, piCodingAgent, bashDarwin, bashDarwinInteractive }:

# The same declared profile is consumed by the feature app and Home Manager.
# It has no broad Home Manager or nix-darwin activation hooks.
let
  inherit (pkgs) lib;
  runtimeShell = "${bashDarwin}/bin/bash";
  writeShellApplication = (pkgs.callPackage "${pkgs.path}/pkgs/build-support/trivial-builders" {
    inherit runtimeShell;
  }).writeShellApplication;
  makeWrapper = pkgs.makeWrapper.overrideAttrs { shell = runtimeShell; };
  host = writeShellApplication {
    name = "hunk";
    text = ''
      export XDG_RUNTIME_DIR="$HOME/.local/state/hunk-turn-review/hunk-runtime"
      export HUNK_MCP_HOST=127.0.0.1
      export HUNK_MCP_PORT=47658
      if [[ -z "''${HUNK_TURN_REVIEW_SESSION_ID:-}" ]]; then
        unset HUNK_TURN_REVIEW_SOCKET
      fi
      if (( $# == 0 )); then set -- diff; fi
      exec ${hunkReviewHost}/bin/hunk "$@"
    '';
  };
  runtime = writeShellApplication {
    name = "hunk-turn-review-runtime";
    runtimeInputs = [ pkgs.git ];
    text = ''
      state="''${HUNK_TURN_REVIEW_STATE:-$HOME/.local/state/hunk-turn-review/data}"
      socket="''${HUNK_TURN_REVIEW_SOCKET:-$state/runtime.sock}"
      exec ${pkgs.nodejs_22}/bin/node \
        ${hunkTurnReviewAssets}/share/home/.local/share/hunk-turn-review/dist/runtime.js \
        --state "$state" --socket "$socket" --pluginId hunk-turn-review --entrypoint review
    '';
  };
  control = writeShellApplication {
    name = "hunk-turn-review-control";
    text = ''
      exec ${pkgs.nodejs_22}/bin/node \
        ${hunkTurnReviewAssets}/share/home/.local/share/hunk-turn-review/dist/control.js "$@"
    '';
  };
  review = writeShellApplication {
    name = "hunk-turn-review";
    text = ''
      : "''${HUNK_TURN_REVIEW_SOCKET:?Missing installed review socket}"
      : "''${HUNK_TURN_REVIEW_SESSION_ID:?Missing original native review session}"
      export XDG_RUNTIME_DIR="$HOME/.local/state/hunk-turn-review/hunk-runtime"
      export XDG_CONFIG_HOME="$HOME/.local/state/hunk-turn-review/hunk-config"
      export HUNK_MCP_HOST=127.0.0.1
      export HUNK_MCP_PORT=47658
      exec ${hunkReviewHost}/bin/hunk \
        --extension ${hunkTurnReviewAssets}/share/home/.config/hunk/extensions/human-review \
        turn-review "$@"
    '';
  };
  codex = writeShellApplication {
    name = "codex";
    runtimeInputs = [ bashDarwinInteractive pkgs.git ];
    text = ''
      exec ${pkgs.python3}/bin/python3 ${../runtime/hunk-turn-review-codex.py} \
        --binary /opt/homebrew/bin/codex -- "$@"
    '';
  };
  plugin = pkgs.writeTextDir "share/home/.config/herdr/plugins/hunk-turn-review/herdr-plugin.toml" ''
    id = "hunk-turn-review"
    name = "Automatic Hunk response review"
    version = "1.0.0"
    min_herdr_version = "0.9.3"
    platforms = ["macos"]
    [[panes]]
    id = "review"
    title = "Hunk response review"
    command = ["${review}/bin/hunk-turn-review"]
    placement = "split"
  '';
in pkgs.symlinkJoin {
  name = "hunk-turn-review-profile-1.0.0";
  paths = [ host hunkReviewHostTypes runtime control review codex plugin hunkTurnReviewAssets piCodingAgent bashDarwinInteractive ];
  nativeBuildInputs = [ makeWrapper ];
  postBuild = ''
    mkdir -p "$out/share/hunk-turn-review" "$out/share/hunk"
    cp ${hunkReviewHost}/share/hunk/provenance.json "$out/share/hunk/"
    cp ${hunkReviewHost}/share/hunk/extension-api/types.d.ts "$out/share/hunk-turn-review/host-types.d.ts"
    cp ${../runtime/hunk-turn-review-install.py} "$out/share/hunk-turn-review/install.py"
    ${pkgs.python3}/bin/python3 ${../runtime/hunk-turn-review-manifest.py} \
      "$out" ${hunkTurnReviewAssets} ${runtime} ${pkgs.nodejs_22}
    makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/hunk-turn-review-install" \
      --add-flags "$out/share/hunk-turn-review/install.py" \
      --add-flags "--profile $out"
    # Keep packaged Hunk/Pi assets intact, but use the repaired interpreter for
    # their profile wrappers too. Never write through a symlink into an input.
    for wrapper in "$out"/bin/*; do
      if grep -Eq '^#![[:space:]]*${pkgs.runtimeShell}([[:space:]].*)?$' "$wrapper"; then
        cp "$wrapper" "$TMPDIR/profile-wrapper"
        chmod u+w "$TMPDIR/profile-wrapper"
        substituteInPlace "$TMPDIR/profile-wrapper" \
          --replace-fail '${pkgs.runtimeShell}' '${runtimeShell}'
        rm "$wrapper"
        cp "$TMPDIR/profile-wrapper" "$wrapper"
      fi
    done
    export PATH=${lib.makeBinPath [ pkgs.git ]}:$PATH
    ${pkgs.python3}/bin/python3 ${../tests/bash-profile.py} \
      "$out" ${bashDarwin}/bin/bash ${bashDarwinInteractive}/bin/bash
    ${pkgs.python3}/bin/python3 ${../tests/hunk-turn-review-artifact.py} "$out"
  '';
  passthru = { inherit hunkReviewHost hunkTurnReviewAssets bashDarwin bashDarwinInteractive; };
}
