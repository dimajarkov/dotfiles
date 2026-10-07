{ pkgs }:

pkgs.buildNpmPackage rec {
  pname = "pi-coding-agent";
  version = "1.0.3";

  src = pkgs.fetchFromGitHub {
    owner = "earendil-works";
    repo = "pi";
    rev = "d78dc83d633229d12f8b79631384c4c2717c399f";
    hash = "sha256-2SfC8zEf6emG1sDG1J7hjjSBt+3hFIz1/TcwBLa/hRU=";
  };

  npmDepsHash = "sha256-SpbadDFtPdwn+H2TXDl1TGAI+ejb6dbRvALZoUIvx3c=";

  # Native queue admission must be observable before acknowledging child control.
  patches = [ ../patches/pi-native-message-admission.patch ];

  postPatch = let
    modelData = pkgs.fetchurl {
      url = "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-${version}.tgz";
      hash = "sha256-3YmV+x3zyj4r0DMFO9LCi0DES7f1PCU1eMpoCCYR4O4=";
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
