{ pkgs }:

pkgs.buildNpmPackage rec {
  pname = "pi-coding-agent";
  version = "1.4.0";

  src = pkgs.fetchFromGitHub {
    owner = "earendil-works";
    repo = "pi";
    rev = "4a080252f06caf63a525d7873c5d94d3c23887e0";
    hash = "sha256-N9NOpiiZTbOMDMV+CxvJAgtLjJJ1/8NJBGS0cFHkhsc=";
  };

  npmDepsHash = "sha256-aBzVz78IxZQlzPYC72Ufa2YFtkow6nZR24YBYZrv9W0=";

  # Native admission and per-request provenance must match the deployed adapters.
  patches = [
    ../patches/pi-native-message-admission.patch
    ../patches/pi-user-request-lifecycle.patch
  ];

  postPatch = let
    modelData = pkgs.fetchurl {
      url = "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-${version}.tgz";
      hash = "sha256-tA4rqLtvwzKQj4uW6DfcLR/ftF65zTgvWu0RFGKYHjw=";
    };
  in ''
    mkdir -p packages/ai/src/providers/data
    tar -xzf ${modelData} --strip-components=4 \
      -C packages/ai/src/providers/data package/dist/providers/data
  '';
  npmFlags = [ "--ignore-scripts" ];
  npmBuildScript = "build:offline";
  nodejs = pkgs.nodejs_22;
  nativeBuildInputs = [ pkgs.makeWrapper pkgs.bun ];

  installPhase = ''
    runHook preInstall
    npm prune --omit=dev --ignore-scripts --offline
    mkdir -p "$out/lib/pi-coding-agent" "$out/bin"
    cp -a package.json node_modules packages "$out/lib/pi-coding-agent/"
    makeWrapper ${nodejs}/bin/node "$out/bin/pi" \
      --add-flags "$out/lib/pi-coding-agent/packages/coding-agent/dist/cli.js" \
      --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.ripgrep pkgs.fd ]}
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    "$out/bin/pi" --version
    PI_OFFLINE=1 ${nodejs}/bin/node ${../tests/pi-message-admission.mjs} \
      "$out/lib/pi-coding-agent/packages"
    PI_OFFLINE=1 ${nodejs}/bin/node ${../tests}/pi-user-request-lifecycle.mjs \
      "$out/lib/pi-coding-agent/packages"
    echo "Checking Node worker file descriptor tracking"
    cat > "$TMPDIR/fd-worker.cjs" <<'EOF'
    const { closeSync, openSync, readSync } = require("node:fs");
    for (let i = 0; i < 800; i++) {
      const fd = openSync("/dev/null", "r");
      readSync(fd, Buffer.alloc(16), 0, 16, 0);
      closeSync(fd);
    }
    EOF
    cat > "$TMPDIR/fd-main.cjs" <<'EOF'
    const { Worker } = require("node:worker_threads");
    const worker = new Worker(process.argv[2]);
    worker.on("error", error => {
      console.error(error);
      process.exitCode = 1;
    });
    EOF
    ${nodejs}/bin/node "$TMPDIR/fd-main.cjs" "$TMPDIR/fd-worker.cjs" \
      2> "$TMPDIR/fd-warnings.log"
    if grep -q "unmanaged mode" "$TMPDIR/fd-warnings.log"; then
      cat "$TMPDIR/fd-warnings.log" >&2
      exit 1
    fi
    runHook postInstallCheck
  '';

  meta = {
    description = "Upstream Pi coding agent";
    homepage = "https://github.com/earendil-works/pi";
    license = pkgs.lib.licenses.mit;
    mainProgram = "pi";
    platforms = pkgs.lib.platforms.darwin ++ pkgs.lib.platforms.linux;
  };
}
