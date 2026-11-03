{ pkgs }:

pkgs.buildNpmPackage {
  pname = "pi-claude-rules";
  version = "0.1.3";

  src = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@jordyvanvorselen/pi-claude-rules/-/pi-claude-rules-0.1.3.tgz";
    hash = "sha512-xxGbIHXfZswibdwC5YmfLo/G5mOoJvQoBt+szsAY3Pmk0viZgPmt+foJgsSSnVdMkGcejv8zmqVdpBapUWc/Wg==";
  };

  # Compare model-visible text rather than JSON escapes after resume/compaction.
  patches = [ ../patches/pi-claude-rules-resume.patch ];
  postPatch = ''
    cp ${./pi-claude-rules/package.json} package.json
    cp ${./pi-claude-rules/package-lock.json} package-lock.json
  '';

  # Runtime-only lock: host imports come from Pi; minimatch fixes CVE-2026-118764.
  npmDepsHash = "sha256-CNeWyfPj+jKckGyN8qsjKqikvi4jGEFNRIHKG/s3rck=";
  npmFlags = [ "--ignore-scripts" ];
  nodejs = pkgs.nodejs_22;
  dontNpmBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp -R src node_modules package.json package-lock.json README.md LICENSE "$out/"
    runHook postInstall
  '';

  meta = {
    description = "Pinned Pi rules extension with compaction-aware activation";
    homepage = "https://github.com/jordyvanvorselen/pi-claude-rules";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.darwin ++ pkgs.lib.platforms.linux;
  };
}
