{ stdenvNoCC, fetchurl, lib }:

stdenvNoCC.mkDerivation {
  pname = "herdr";
  version = "0.9.5";
  src = fetchurl {
    url = "https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-macos-aarch64";
    hash = "sha256-+3fCIyoFqANUITgsiUOS9BdOTjihjkivPdApAVfDp+I=";
  };
  dontUnpack = true;
  dontBuild = true;
  dontFixup = true;
  installPhase = ''
    install -Dm755 "$src" "$out/bin/herdr"
  '';
  meta = {
    description = "Upstream Herdr for the isolated worker user profile";
    license = lib.licenses.asl20;
    platforms = [ "aarch64-darwin" ];
    mainProgram = "herdr";
  };
}
