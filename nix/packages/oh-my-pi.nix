{ stdenvNoCC, fetchurl, lib }:

stdenvNoCC.mkDerivation rec {
  pname = "oh-my-pi";
  version = "18.22.0";

  # Official standalone Apple Silicon build, pinned to its immutable build ID.
  # SHA-256 is published by the upstream build service's release API.
  src = fetchurl {
    url = "https://build.stencil.so/d/omp/20261116-215456-3e8cff3/omp-darwin-arm64";
    hash = "sha256-0YURPWProjkl5dcKtmGkJLgnwGyY+Odmw79K1i3a/5o=";
  };

  dontUnpack = true;
  dontBuild = true;
  dontFixup = true;
  installPhase = ''
    runHook preInstall
    install -Dm755 "$src" "$out/bin/omp"
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    export HOME="$TMPDIR/omp-home"
    mkdir -p "$HOME"
    "$out/bin/omp" --version | grep -Fx 'omp/${version}'
    "$out/bin/omp" --help > /dev/null
    runHook postInstallCheck
  '';

  meta = {
    description = "Oh My Pi coding agent";
    homepage = "https://omp.sh";
    license = lib.licenses.mit;
    platforms = [ "aarch64-darwin" ];
    mainProgram = "omp";
  };
}
