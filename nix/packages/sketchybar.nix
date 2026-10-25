{ sketchybar, python3 }:

# Keep the pinned package and its normal vertical/global scroll behavior.
# Only subscribed wsc.* items opt into fractional, two-axis trackpad browsing.
sketchybar.overrideAttrs (old: {
  patches = (old.patches or []) ++ [ ../patches/sketchybar-workspace-trackpad.patch ];
  nativeBuildInputs = (old.nativeBuildInputs or []) ++ [ python3 ];
  postPatch = (old.postPatch or "") + ''
    ${python3}/bin/python3 ${../../tests/sketchybar-scroll-native.py} --source .
  '';
})
