class Herdr < Formula
  desc "Terminal workspace for coding agents, with managed Pi job APIs"
  homepage "https://github.com/dimajarkov/herdr"
  url "https://github.com/dimajarkov/herdr/archive/e3a21bb0e8eded3c0b97b13083fc54f4c6ff7c6a.tar.gz"
  version "0.9.4"
  sha256 "340f061b464148561256b76f97c1bf1306d0350e35bb4ebc16cf88157d4e161e"
  license "Apache-2.0"
  revision 2

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
    ENV["HERDR_BUILD_ID"] = "e3a21bb0"
    ENV["HERDR_BUILD_COMMIT"] = "e3a21bb0e8eded3c0b97b13083fc54f4c6ff7c6a"
    system "cargo", "install", "--offline", *std_cargo_args
    generate_completions_from_executable(bin/"herdr", "completion")
  end

  test do
    assert_match "0.9.4-pi.e3a21bb0", shell_output("#{bin}/herdr --version")
    schema = JSON.parse(shell_output("#{bin}/herdr api schema --json"))
    methods = schema.fetch("schemas").fetch("request").fetch("oneOf").map do |request|
      request.fetch("properties").fetch("method").fetch("const")
    end
    %w[terminal.job.capabilities terminal.job.launch agent.control.prompt terminal.job.branch_capabilities terminal.job.launch_branch server.live_handoff].each do |method|
      assert_includes methods, method
    end
  end
end
