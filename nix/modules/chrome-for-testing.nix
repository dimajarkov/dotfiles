{ pkgs, ... }:

let
  chromeForTesting = pkgs.callPackage ../packages/chrome-for-testing.nix {};
in {
  # A distinct app identity avoids native Computer Use selecting regular Chrome.
  home.file."Applications/Google Chrome for Testing.app" = {
    source = "${chromeForTesting}/Applications/Google Chrome for Testing.app";
    force = true;
  };
}
