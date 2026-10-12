{ lib, stdenv, bash, fetchurl, writeText, dash, interactive ? true }:

# Retain the locked Nixpkgs source, options, hardening and downstream patches.
# GNU 016 handles Darwin's dynamic pipe capacity without changing semantics.
let
  base = bash.override { inherit interactive; };
  series = [
    { number = "010"; hash = "sha256-z3bxzOLqMAwYv/nwAtIfKAzJMazRfChRgRC5P+bnJWk="; }
    { number = "011"; hash = "sha256-Apjfj16iox075D7X0mnFs8fDQt1bVwvqf2TWbcu+dTE="; }
    { number = "012"; hash = "sha256-1xN5s5vrrtrxI0FEFOd/tFigpDua0xFllMbffKZ1RXM="; }
    { number = "013"; hash = "sha256-BC+c2pZ+JL9CEZRGl0Qek9Bv9CtLmYYpqYobJJJ58gA="; }
    { number = "014"; hash = "sha256-vUNgtAHThQfjWHg9ythTapnGeJ8NOlvQz7jEo0FEaWw="; }
    { number = "015"; hash = "sha256-Vbec7uL8J/Z2fu1pfpOafrL+KijAFVa9dfGNWBAU9G4="; }
    { number = "016"; hash = "sha256-nqKbJmt9JMs00P8/HEYx5NUnv+LR7xXRfNuSS/Me92c="; }
  ];
  official = map (patch: patch // {
    url = "https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-${patch.number}";
  }) series;
  patches = map (patch: fetchurl { inherit (patch) url hash; }) official;
  provenance = writeText "bash-darwin-pipes.json" (builtins.toJSON {
    version = "5.3p16";
    inherit interactive official;
    source = { inherit (base.src) urls outputHash; };
    retainedPatches = map (patch: builtins.baseNameOf (toString patch)) base.patches;
  });
  expected = map (n: "bash53-00${toString n}") (lib.range 1 9);
in
if !stdenv.hostPlatform.isDarwin then base else
assert lib.assertMsg (base.version == "5.3p9" && base.patch_suffix == "p9"
  && builtins.length base.patches >= 9
  && lib.all (pair: lib.hasSuffix pair.fst (toString pair.snd))
    (lib.zipLists expected (lib.take 9 base.patches)))
  "Reinspect the locked Bash recipe before rebasing the Darwin GNU patch series";
base.overrideAttrs (old: {
  version = "5.3p16";
  patch_suffix = "p16";
  # Explicitly keep the original tarball, independent of recursive version attrs.
  src = old.src;
  # Configure itself uses large heredocs. Run that POSIX build step through
  # the locked Nix Dash, since the existing Nix Bash cannot configure its fix.
  # Installed shells and feature wrappers exclusively use the repaired 5.3p16.
  preConfigure = (old.preConfigure or "") + ''
    export CONFIG_SHELL=${dash}/bin/dash
  '';
  patches = lib.take 9 old.patches ++ patches ++ lib.drop 9 old.patches;
  postPatch = (old.postPatch or "") + ''
    grep -F '#define PATCHLEVEL 16' patchlevel.h
    grep -F 'LOCAL_CFLAGS="-DMACOSX -DPIPESIZE_DYNAMIC"' configure
    grep -F 'r == ENOSPC || r == EAGAIN' redir.c
    grep -F 'sh_setnodelay (herepipe[1])' redir.c
  '';
  postFixup = (old.postFixup or "") + ''
    mkdir -p "$out/nix-support/bash-darwin-pipes"
    cp ${provenance} "$out/nix-support/bash-darwin-pipes/source.json"
    grep -E 'HEREDOC_PIPESIZE|PIPESIZE_DYNAMIC|LOCAL_CFLAGS =' config.h Makefile \
      > "$out/nix-support/bash-darwin-pipes/build-config.txt"
    cat builtins/pipesize.h >> "$out/nix-support/bash-darwin-pipes/build-config.txt"
  '';
})
