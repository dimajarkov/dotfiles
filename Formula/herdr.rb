class Herdr < Formula
  desc "Terminal workspace for coding agents, with managed Pi job APIs"
  homepage "https://github.com/dimajarkov/herdr"
  url "https://github.com/dimajarkov/herdr/archive/c8d5b8f0d1b0ab9c7e98d05b1ed5b9606f87599f.tar.gz"
  version "0.9.4"
  sha256 "593fe63aa223f7a64e92cfda6f6fec99cf7c60e5c045d6095a436446db9ddc9e"
  license "Apache-2.0"
  revision 1

  depends_on "rust" => :build
  depends_on "zig@0.16" => :build

  # Deliberate immutable source pin; update only after reviewing the Pi API contract.
  livecheck do
    skip "Pinned compatible Pi build"
  end

  deny_network_access! :test

  def install
    system "cargo", "fetch", "--locked"
    cd "vendor/libghostty-vt" do
      system "zig", "build", "--fetch=all"
    end
    ENV["HERDR_BUILD_CHANNEL"] = "pi"
    ENV["HERDR_BUILD_ID"] = "c8d5b8f0"
    ENV["HERDR_BUILD_COMMIT"] = "c8d5b8f0d1b0ab9c7e98d05b1ed5b9606f87599f"
    system "cargo", "install", "--offline", *std_cargo_args
    generate_completions_from_executable(bin/"herdr", "completion")
  end

  test do
    assert_match "0.9.4-pi.c8d5b8f0", shell_output("#{bin}/herdr --version")
    schema = JSON.parse(shell_output("#{bin}/herdr api schema --json"))
    methods = schema.fetch("schemas").fetch("request").fetch("oneOf").map do |request|
      request.fetch("properties").fetch("method").fetch("const")
    end
    %w[terminal.job.capabilities terminal.job.launch agent.control.prompt].each do |method|
      assert_includes methods, method
    end
  end
end
