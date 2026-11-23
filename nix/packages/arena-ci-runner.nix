{ pkgs }:

# Opt-in artifact only. Neither darwin nor Home Manager activation owns it.
pkgs.runCommand "arena-ci-runner-1.0.0" {
  nativeBuildInputs = [ pkgs.makeWrapper ];
  meta.description = "Guarded startup and explicit disk-only installer for the existing Arena CI runner";
} ''
  mkdir -p "$out/share/arena-ci" "$out/bin"
  cp ${../runtime/arena-ci-runtime.py} "$out/share/arena-ci/arena-ci-runtime.py"
  cp ${../runtime/arena-ci-install.py} "$out/share/arena-ci/arena-ci-install.py"
  substitute ${../runtime/arena-ci-bootstrap.sh} "$out/share/arena-ci/bootstrap.sh" \
    --subst-var-by python '${pkgs.python3}/bin/python3' \
    --subst-var-by runtime "$out/share/arena-ci/arena-ci-runtime.py" \
    --subst-var-by mode start
  substitute ${../runtime/arena-ci-bootstrap.sh} "$out/share/arena-ci/job-start.sh" \
    --subst-var-by python '${pkgs.python3}/bin/python3' \
    --subst-var-by runtime "$out/share/arena-ci/arena-ci-runtime.py" \
    --subst-var-by mode check
  chmod 755 "$out/share/arena-ci/"*.sh
  ln -s ${pkgs.nix}/bin/nix-store "$out/share/arena-ci/nix-store"
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/arena-ci-install" \
    --add-flags "-I $out/share/arena-ci/arena-ci-install.py --profile $out"
''
