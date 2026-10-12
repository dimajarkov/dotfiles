{ stdenvNoCC, fetchurl }:

# Project-isolated package manager; does not alter the machine's Bun owner.
stdenvNoCC.mkDerivation {
  pname = "hunk-turn-review-bun";
  version = "1.3.14";
  src = fetchurl {
    url = "https://registry.npmjs.org/@oven/bun-darwin-aarch64/-/bun-darwin-aarch64-1.3.14.tgz";
    hash = "sha256-YD0yejk8Mv7F2ecWXF9Xr8KPHITvhVk0SIcMzEG9pjY=";
  };
  sourceRoot = "package";
  dontBuild = true;
  dontStrip = true;
  installPhase = ''
    mkdir -p "$out/bin"
    cp -p bin/bun "$out/bin/bun"
    test "$("$out/bin/bun" --version)" = "1.3.14"
  '';
}
