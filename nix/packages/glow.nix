{ glow }:

# Backport direct-file content caching until the pinned Glow release includes it.
# Glow 2.1.2 renders an empty Body on WindowSizeMsg, blanking :Glow on resize.
glow.overrideAttrs (previous: {
  patches = (previous.patches or []) ++ [ ../patches/glow-resize.patch ];
  preBuild = (previous.preBuild or "") + ''
    export GLOW_CONFIG_HOME="$TMPDIR/glow-config"
    mkdir -p "$GLOW_CONFIG_HOME"
  '';
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    go test ./... -count=1
    runHook postCheck
  '';
})
