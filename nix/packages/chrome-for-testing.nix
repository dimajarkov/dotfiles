{ lib, stdenvNoCC, fetchurl, unzip }:

stdenvNoCC.mkDerivation {
  pname = "chrome-for-testing";
  version = "155.0.8059.79";

  src = fetchurl {
    url = "https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.79/mac-arm64/chrome-mac-arm64.zip";
    hash = "sha256-4UGny/lIeAu304GGC9WnlExnNvebmRi5gm/MsZnSjqQ=";
  };
  nativeBuildInputs = [ unzip ];
  sourceRoot = "chrome-mac-arm64";
  dontConfigure = true;
  dontBuild = true;
  # Preserve the official bundle without Mach-O rewriting or stripping.
  dontFixup = true;
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/Applications"
    cp -R "Google Chrome for Testing.app" "$out/Applications/"
    runHook postInstall
  '';

  meta = {
    description = "Pinned dedicated Chrome app for isolated native browser QA";
    homepage = "https://developer.chrome.com/docs/automation-and-testing/chrome-for-testing";
    license = lib.licenses.unfree;
    platforms = [ "aarch64-darwin" ];
  };
}
