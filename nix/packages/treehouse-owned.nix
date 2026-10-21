{ pkgs, source }:
let
  revision = source.rev;
  backing = pkgs.callPackage "${source}/package.nix" {};
in pkgs.runCommand "treehouse-owned-${builtins.substring 0 12 revision}" {
  nativeBuildInputs = [ pkgs.makeWrapper ];
  passthru = { inherit backing revision; };
  meta.description = "Pinned personal Treehouse fork and explicit guarded installer";
} ''
  mkdir -p "$out/share/treehouse-owned" "$out/bin"
  cp ${backing}/bin/treehouse "$out/share/treehouse-owned/treehouse-bin"
  cp ${source}/owner-wrapper/treehouse.sh "$out/share/treehouse-owned/treehouse"
  cp ${../runtime/treehouse-owned-install.py} "$out/share/treehouse-owned/install.py"
  chmod 500 "$out/share/treehouse-owned/treehouse-bin"
  chmod 755 "$out/share/treehouse-owned/treehouse"
  ${pkgs.python3}/bin/python3 - "$out/share/treehouse-owned" <<'PY'
  import hashlib,json,pathlib,sys
  root=pathlib.Path(sys.argv[1])
  value={"schema":"treehouse.owned-artifact.v1","source":"github:dimajarkov/treehouse/${revision}","revision":"${revision}","assets":{name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in ["treehouse","treehouse-bin"]}}
  (root/"manifest.json").write_text(json.dumps(value,sort_keys=True,indent=2)+"\n")
  PY
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/treehouse-owned-install" \
    --add-flags "$out/share/treehouse-owned/install.py --profile $out" \
    --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.nix ]}
''
