{ codex, fetchFromGitHub, fetchurl, rustPlatform }:

# Keep the status-line directory to the final two path components.
# Pin to the same release as codex.nix so the CLI and native helpers stay aligned.
codex.overrideAttrs (final: old: {
  version = "0.169.0";
  src = fetchFromGitHub {
    owner = "openai";
    repo = "codex";
    tag = "rust-v0.169.0";
    hash = "sha256-p8Vw0Vu8ufPY35k/RkcKE6HOTMJta2J9W33ei/7in+A=";
  };
  cargoDeps = rustPlatform.fetchCargoVendor {
    inherit (final) src;
    sourceRoot = "${final.src.name}/codex-rs";
    hash = "sha256-+YSkZwmAP88AOFmNWav4ye4ObbDYAIo0mzeQEzTqDm8=";
  };
  patches = (old.patches or []) ++ [ ../patches/codex-short-cwd.patch ];
  postPatch = "";
  env = (builtins.removeAttrs old.env [ "LK_CUSTOM_WEBRTC" ]) // {
    # Use the same verified V8 artifacts as this Codex release's CI.
    RUSTY_V8_ARCHIVE = fetchurl {
      url = "https://github.com/openai/codex/releases/download/rusty-v8-v152.2.0/librusty_v8_ptrcomp_sandbox_release_aarch64-apple-darwin.a.gz";
      sha256 = "feab9ae0384bebaa99c1d000654462c9d42123d587185c7876aaeef7d76ff749";
    };
    RUSTY_V8_SRC_BINDING_PATH = fetchurl {
      url = "https://github.com/openai/codex/releases/download/rusty-v8-v152.2.0/src_binding_ptrcomp_sandbox_release_aarch64-apple-darwin.rs";
      sha256 = "b9d5652ebca515eb2bf4c2ee4a6551b2567117b5aa720f430d2032616dd7e3b5";
    };
    CARGO_PROFILE_RELEASE_LTO = "false";
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS = "16";
  };
  cargoBuildFlags = [ "--package" "codex-cli" "--bin" "codex" ];
})
