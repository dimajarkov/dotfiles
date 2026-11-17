{ stdenvNoCC, fetchurl, lib, callPackage }:

let
  shortCwdCodex = callPackage ./codex-short-cwd.nix {};
in
stdenvNoCC.mkDerivation {
  pname = "codex";
  version = "0.169.0";

  src = fetchurl {
    url = "https://registry.npmjs.org/@openai/codex/-/codex-0.169.0-darwin-arm64.tgz";
    hash = "sha256-1n1EMlMpRDiiH94VdT18EXTmoyFH2ELrhEKEedZkyT0=";
  };

  # Keep native helpers and voice resources beside the upstream binaries.
  dontBuild = true;
  dontFixup = true;
  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp -R vendor/aarch64-apple-darwin/. "$out/"
    chmod u+w "$out/bin/codex"
    # Copy the executable, not nixpkgs' launcher, so package discovery finds
    # codex-package.json and native helpers in this complete package.
    cp ${shortCwdCodex}/bin/.codex-wrapped "$out/bin/codex"
    runHook postInstall
  '';

  meta = {
    description = "OpenAI Codex CLI";
    homepage = "https://github.com/openai/codex";
    license = lib.licenses.asl20;
    platforms = [ "aarch64-darwin" ];
    mainProgram = "codex";
  };
}
