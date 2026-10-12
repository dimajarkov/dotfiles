{ pkgs, hunkReviewHost }:

# Available independently of the UI build, so API changes can be adopted first.
pkgs.writeShellApplication {
  name = "hunk-review-host-types";
  runtimeInputs = [ pkgs.coreutils ];
  text = ''
    if (( $# != 1 )); then
      echo "Usage: hunk-review-host-types <extension .host-types directory>" >&2
      exit 2
    fi
    mkdir -p -- "$1"
    cp -- ${hunkReviewHost}/share/hunk/extension-api/types.d.ts "$1/types.d.ts"
  '';
}
