{ pkgs, bashDarwin, bashDarwinInteractive }:

# Fail evaluation on accidental source, hardening or option drift.
let
  preserved = [
    "src" "configureFlags" "hardeningDisable" "NIX_CFLAGS_COMPILE"
    "outputs" "patchFlags" "buildInputs" "nativeBuildInputs" "strictDeps"
    "separateDebugInfo" "postInstall"
  ];
  sameRecipe = candidate: interactive:
    let original = pkgs.bash.override { inherit interactive; }; in
    pkgs.lib.all (key: candidate.drvAttrs.${key} == original.drvAttrs.${key}) preserved
    && pkgs.lib.take 9 candidate.patches == pkgs.lib.take 9 original.patches
    && pkgs.lib.drop 16 candidate.patches == pkgs.lib.drop 9 original.patches
    && builtins.length candidate.patches == builtins.length original.patches + 7
    && candidate.version == "5.3p16" && candidate.patch_suffix == "p16";
in
assert sameRecipe bashDarwin false;
assert sameRecipe bashDarwinInteractive true;
pkgs.runCommand "bash-darwin-source-check" {} ''touch "$out"''
