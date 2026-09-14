// Test-only runtime selection: real Herdr commands, with PATH pinned on every new surface.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const originalPath = process.env.PATH;
const realHerdr = execFileSync("/usr/bin/which", ["herdr"], { encoding: "utf8" }).trim();
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export function configureE2ERuntime(directory) {
  const runtime = process.env.PI_E2E_RUNTIME && realpathSync(process.env.PI_E2E_RUNTIME);
  if (runtime) {
    assert.ok(existsSync(join(runtime, "bin", "pi")), "PI_E2E_RUNTIME must be a built Pi package");
    const bin = join(directory, "runtime-tools");
    mkdirSync(bin);
    const path = `${bin}:${runtime}/bin:${originalPath}`;
    writeFileSync(
      join(bin, "herdr"),
      `#!/bin/bash
case "$1:$2" in
  tab:create|pane:split) exec ${quote(realHerdr)} "$@" --env ${quote(`PATH=${path}`)} ;;
  *) exec ${quote(realHerdr)} "$@" ;;
esac
`,
      { mode: 0o700 },
    );
    process.env.PATH = path;
  }
  const evidence = join(directory, "runtime-proofs");
  mkdirSync(evidence);
  writeFileSync(
    join(directory, "extensions", "runtime-proof.ts"),
    `
import { writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
export default function (pi) {
  pi.on("session_start", (_event, ctx) => {
    writeFileSync(join(${JSON.stringify(evidence)}, process.pid + ".json"), JSON.stringify({
      cli: realpathSync(process.argv[1]),
      nativeAdmission: typeof pi.enqueueMessage === "function",
      session: ctx.sessionManager.getSessionFile(),
    }));
  });
}
`,
  );
  return (sessions) => {
    const proofs = readdirSync(evidence).map((name) =>
      JSON.parse(readFileSync(join(evidence, name), "utf8")),
    );
    assert.ok(proofs.length > 0, "actual Pi processes must publish runtime evidence");
    for (const proof of proofs) {
      assert.equal(
        proof.nativeAdmission,
        true,
        "every actual Pi process must expose native admission",
      );
      if (runtime)
        assert.equal(
          proof.cli,
          join(runtime, "lib/pi-coding-agent/packages/coding-agent/dist/cli.js"),
        );
    }
    for (const session of sessions.filter(Boolean)) {
      assert.ok(
        proofs.some(
          (proof) =>
            // Empty sessions have an allocated filename but are not persisted yet.
            proof.session &&
            join(realpathSync(dirname(proof.session)), basename(proof.session)) ===
              join(realpathSync(dirname(resolve(session))), basename(session)),
        ),
        `missing runtime proof for ${session}`,
      );
    }
    console.log(
      `PASS runtime provenance: ${proofs.length} actual Pi processes${runtime ? ` from ${runtime}` : " with native admission"}`,
    );
  };
}
