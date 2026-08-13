{ pkgs }:

pkgs.buildNpmPackage rec {
  pname = "pi-coding-agent";
  version = "0.84.1";

  src = pkgs.fetchFromGitHub {
    owner = "earendil-works";
    repo = "pi";
    rev = "2e4d23959485279aa2da1a45103de2ea22d46395";
    hash = "sha256-Z92ZxL2WdbRl7H1mHbN2sWfH/9ndpqLtBxEv5+A5fbg=";
  };

  npmDepsHash = "sha256-GP8ksj6HJcK0id6VDr1c/WoHDwK1T50qJnYfj94ljDs=";

  postPatch = ''
    tar -xzf ${../../vendor/pi-model-data-2e4d239.tar.gz}
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
