{ upstreamHost, python3 }:

# Reuse the exact upstream bun2nix dependency closure and archived Bun 1.4.2.
# Both binary and public declarations are emitted from this patched source.
upstreamHost.overrideAttrs (old: {
  pname = "hunk-review-host";
  patches = (old.patches or []) ++ [ ../patches/hunk-review-persistence.patch ];
  # This bun2nix release's bunPatchPhase only patches shebangs, ignoring patches.
  # Use stdenv's real patch phase and retain the hook's isolated build HOME.
  dontUseBunPatch = true;
  postPatch = (old.postPatch or "") + ''
    export HOME=$(mktemp -d)
  '';
  postBuild = (old.postBuild or "") + ''
    ./node_modules/.bin/tsc --target ES2022 --module ESNext \
      --skipLibCheck --declaration --emitDeclarationOnly \
      --outDir public-extension-api packages/hunk/src/extension-api/types.ts
  '';
  postInstall = (old.postInstall or "") + ''
    mkdir -p "$out/share/hunk/extension-api"
    cp public-extension-api/types.d.ts "$out/share/hunk/extension-api/"
    cp ${../patches/hunk-review-persistence.json} "$out/share/hunk/provenance.json"
  '';
  doInstallCheck = true;
  installCheckPhase = ''
    ${python3}/bin/python3 ${../tests/hunk-review-host.py} "$out"
  '';
})
