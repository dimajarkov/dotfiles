{ lib, stdenvNoCC, fetchurl }:

# Official standalone release, with its matching bundled agent skills.
stdenvNoCC.mkDerivation {
  pname = "hunk";
  version = "0.23.0";
  src = fetchurl {
    url = "https://github.com/modem-dev/hunk/releases/download/v0.23.0/hunkdiff-darwin-arm64.tar.gz";
    hash = "sha256-rkLP5SeYpPUdJfY864aFyipsswOaEk1qb8FyoRL41rg=";
  };
  dontBuild = true;
  dontStrip = true;
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/bin"
    cp hunk "$out/bin/hunk"
    cp -R skills "$out/bin/skills"
    runHook postInstall
  '';
  doInstallCheck = true;
  installCheckPhase = ''
    test "$("$out/bin/hunk" --version)" = "$version"
    test -f "$("$out/bin/hunk" skill path)"
    test -f "$("$out/bin/hunk" skill path hunk-extensions)"
  '';
  meta = {
    description = "Native terminal code review with human inline notes";
    homepage = "https://hunk.dev";
    license = lib.licenses.mit;
    platforms = [ "aarch64-darwin" ];
    mainProgram = "hunk";
  };
}
