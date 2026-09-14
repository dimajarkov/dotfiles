{
  buildNpmPackage,
  lib,
  makeWrapper,
  nodejs_22,
}:

buildNpmPackage {
  pname = "backpass";
  version = "0.1.22";

  src = ./backpass-runtime;
  npmDepsHash = "sha256-iDmd2nP8DvJ1D1E6tip2vX/fIqVCxM87OEtc4ODL4+k=";
  npmFlags = [ "--ignore-scripts" ];
  dontNpmBuild = true;

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/bin" "$out/libexec/backpass"
    cp -R node_modules "$out/libexec/backpass/"

    makeWrapper ${nodejs_22}/bin/node "$out/bin/acpx" \
      --add-flags "$out/libexec/backpass/node_modules/acpx/dist/cli.js" \
      --prefix PATH : "${lib.makeBinPath [ nodejs_22 ]}"
    makeWrapper ${nodejs_22}/bin/node "$out/bin/backpass" \
      --add-flags "$out/libexec/backpass/node_modules/backpass/bin/backpass.js" \
      --prefix PATH : "$out/bin:${lib.makeBinPath [ nodejs_22 ]}"

    runHook postInstall
  '';

  meta = {
    description = "Evidence-backed training for agent memory files";
    homepage = "https://github.com/kunchenguid/backpass";
    license = lib.licenses.mit;
    mainProgram = "backpass";
    platforms = lib.platforms.darwin ++ lib.platforms.linux;
  };
}
