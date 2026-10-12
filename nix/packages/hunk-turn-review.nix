{ lib, pkgs, bun2nix, hunkReviewHost, piCodingAgent, bashDarwin }:

let
  bunCompiler = pkgs.callPackage ./hunk-turn-review/bun-compiler.nix {};
  roots = [
    ".local/share/hunk-turn-review"
    ".config/hunk/extensions/human-review"
    ".pi/agent/extensions/hunk-turn-review"
    ".codex/hunk-turn-review"
    ".config/herdr/plugins/hunk-turn-review"
  ];
  assets = lib.cleanSourceWith {
    src = ../../home;
    filter = path: type:
      let
        relative = lib.removePrefix (toString ../../home + "/") (toString path);
        parts = lib.splitString "/" relative;
      in
      !(lib.any (part: builtins.elem part [ "node_modules" "dist" ".host-types" ".git" ]) parts)
      && lib.any (root: relative == root || lib.hasPrefix (root + "/") relative
        || (type == "directory" && lib.hasPrefix (relative + "/") root)) roots;
  };
  common = {
    # This package's build script itself exercises heredocs over 512 bytes.
    realBuilder = "${bashDarwin}/bin/bash";
    src = assets;
    dontRunLifecycleScripts = true;
    dontStrip = true;
    dontUseBunPatch = true;
    postPatch = ''export HOME=$(mktemp -d)'';
    bunInstallFlags = [ "--frozen-lockfile" "--linker=isolated" "--backend=symlink" ];
    preBunNodeModulesInstallPhase = ''
      export PATH=${bunCompiler}/bin:$PATH
      test "$(bun --version)" = "1.3.14"
    '';
  };
  core = bun2nix.mkDerivation (common // {
    pname = "hunk-turn-review-runtime";
    version = "1.0.0";
    bunRoot = ".local/share/hunk-turn-review";
    bunDeps = bun2nix.fetchBunDeps { bunNix = ./hunk-turn-review/runtime-bun.lock.nix; };
    buildPhase = ''
      cd "$bunRoot"
      ${pkgs.nodejs_22}/bin/node node_modules/typescript/bin/tsc -p tsconfig.build.json
      ${pkgs.nodejs_22}/bin/node <<'NODE'
      const fs = require('node:fs');
      const path = require('node:path');
      const bunTypes = require.resolve('@types/bun/package.json');
      const nodeTypes = require.resolve('@types/node/package.json', { paths: [path.dirname(bunTypes)] });
      fs.writeFileSync('.pi-adapter-types.json', JSON.stringify({
        compilerOptions: {
          target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext',
          strict: true, skipLibCheck: true, noEmit: true, types: ['node'],
          typeRoots: [path.dirname(path.dirname(nodeTypes))],
          paths: { '@earendil-works/pi-coding-agent': [
            '${piCodingAgent}/lib/pi-coding-agent/packages/coding-agent/dist/index.d.ts'
          ] }
        },
        files: [path.resolve('../../../.pi/agent/extensions/hunk-turn-review/index.ts')]
      }));
      NODE
      ${pkgs.nodejs_22}/bin/node node_modules/typescript/bin/tsc -p .pi-adapter-types.json
    '';
    installPhase = ''
      mkdir -p "$out/share/home/.local/share/hunk-turn-review/dist"
      cp dist/src/*.js "$out/share/home/.local/share/hunk-turn-review/dist/"
      cp client.mjs package.json "$out/share/home/.local/share/hunk-turn-review/"
      mkdir -p "$out/share/home/.pi/agent/extensions/hunk-turn-review"
      cp ${assets}/.pi/agent/extensions/hunk-turn-review/*.ts \
        "$out/share/home/.pi/agent/extensions/hunk-turn-review/"
      if [ -d ${assets}/.codex/hunk-turn-review ]; then
        mkdir -p "$out/share/home/.codex/hunk-turn-review"
        cp ${assets}/.codex/hunk-turn-review/*.mjs "$out/share/home/.codex/hunk-turn-review/"
        for fragment in ${assets}/.codex/hunk-turn-review/*.json; do
          [ ! -f "$fragment" ] || cp "$fragment" "$out/share/home/.codex/hunk-turn-review/"
        done
      fi
    '';
  });
  ui = bun2nix.mkDerivation (common // {
    pname = "hunk-turn-review-extension";
    version = "1.0.0";
    bunRoot = ".config/hunk/extensions/human-review";
    bunDeps = bun2nix.fetchBunDeps { bunNix = ./hunk-turn-review/ui-bun.lock.nix; };
    buildPhase = ''
      cd "$bunRoot"
      mkdir -p .host-types
      cp ${hunkReviewHost}/share/hunk/extension-api/types.d.ts .host-types/types.d.ts
      ${pkgs.nodejs_22}/bin/node node_modules/typescript/bin/tsc --noEmit
    '';
    installPhase = ''
      mkdir -p "$out/share/home/.config/hunk/extensions/human-review/.host-types"
      cp *.ts package.json "$out/share/home/.config/hunk/extensions/human-review/"
      cp .host-types/types.d.ts "$out/share/home/.config/hunk/extensions/human-review/.host-types/"
    '';
  });
in
pkgs.runCommand "hunk-turn-review-assets-1.0.0" {
  passthru = { inherit core ui bunCompiler; };
} ''
  # Keep one real tree: native loaders resolve symlinked modules before resolving
  # their relative client imports, and the runtime's CLI checks import.meta.url.
  mkdir -p "$out/share/home"
  cp -RL ${core}/share/home/. "$out/share/home/"
  cp -RL ${ui}/share/home/. "$out/share/home/"
''
