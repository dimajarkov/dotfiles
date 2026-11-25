{ fetchurl, lib, rustPlatform }:

rustPlatform.buildRustPackage rec {
  pname = "plannotator-tui";
  version = "0.11.7";

  src = fetchurl {
    url = "https://codeload.github.com/plannotator/plannotator-tui/tar.gz/refs/tags/v${version}";
    name = "${pname}-${version}.tar.gz";
    hash = "sha256-CnbvEl+to3Xz++xubYjkXAAUxGcruz4RPiZT77gKDDI=";
  };
  cargoHash = "sha256-gPVpWLcJe1CNyEZv32tvphRuBS5rUU8n9dfwHak/noI=";

  # Rex preview.23 supplies REX_BLOCK but not REX_SESSION in review panes.
  # Rex accepts a full block ID wherever the CLI expects a session target.
  postPatch = ''
    substituteInPlace crates/plannotator-tui/src/rex/command.rs \
      --replace-fail '.or_else(|| non_empty("REX_SESSION"))' \
        '.or_else(|| non_empty("REX_SESSION")).or_else(|| non_empty("REX_BLOCK"))'
    substituteInPlace crates/plannotator-tui/src/rex/command.rs \
      --replace-fail '    session: String,' '    pub(super) session: String,'
    substituteInPlace crates/plannotator-tui/src/rex/launch.rs \
      --replace-fail '    let mut args = argv(&exe, block, fg, review, handoff)?;' \
        '    let mut args = argv(&exe, block, fg, review, handoff)?;
    args.insert(1, format!("REX_SESSION={}", rex.session));'
    substituteInPlace crates/plannotator-tui/src/rex/launch.rs \
      --replace-fail '            args.extend(["--host".to_owned(), host.to_owned()]);' \
        '            args.extend(["--host".to_owned(), host.to_owned()]);
            if host == "omp" {
                let transcript = omp_transcript(fg.pid)?;
                args.extend(["--session".to_owned(), transcript]);
            }' \
      --replace-fail '/// The argv the pane runs:' \
        '/// OMP requires an exact transcript. Scope discovery to the foreground process.
fn omp_transcript(pid: u32) -> Result<String> {
    let output = std::process::Command::new("/usr/sbin/lsof")
        .args(["-a", "-p", &pid.to_string(), "-Fn"])
        .output()
        .context("reading open files for Oh My Pi")?;
    let files = String::from_utf8(output.stdout).context("reading Oh My Pi transcript paths")?;
    let mut transcripts = files.lines().filter_map(|line| {
        let path = line.strip_prefix("n")?;
        let name = Path::new(path).file_name()?.to_str()?;
        let (_, id) = name.strip_suffix(".jsonl")?.rsplit_once("_")?;
        let parts = id.split("-");
        (path.starts_with("/")
            && parts.clone().map(str::len).eq([8, 4, 4, 4, 12])
            && parts.flat_map(str::bytes).all(|c| c.is_ascii_hexdigit()))
            .then_some(path)
    });
    let path = transcripts.next().context("Oh My Pi has no open session transcript")?;
    anyhow::ensure!(transcripts.all(|candidate| candidate == path), "Oh My Pi has multiple open session transcripts");
    Ok(path.to_owned())
}

/// The argv the pane runs:'
    substituteInPlace crates/plannotator-tui/src/herdr/launch.rs \
      --replace-fail '        "codex" => Some("codex"),' \
        '        "codex" => Some("codex"),
        "omp" | "oh-my-pi" => Some("omp"),'
  '';

  # The pinned nixpkgs compiler is one release behind the workspace MSRV.
  cargoBuildFlags = [ "--ignore-rust-version" "-p" "plannotator-tui" ];
  cargoTestFlags = [ "--ignore-rust-version" "-p" "plannotator-tui" "rex::command::tests" ];

  meta = {
    description = "Annotate terminal output, documents, and diffs and send feedback to coding agents";
    homepage = "https://github.com/plannotator/plannotator-tui";
    license = lib.licenses.mit;
    mainProgram = "plannotator-tui";
  };
}
