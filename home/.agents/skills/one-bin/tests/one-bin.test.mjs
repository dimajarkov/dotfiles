import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = new URL("../scripts/one-bin.mjs", import.meta.url).pathname;

function run(args, environment = process.env, cwd = process.cwd()) {
	return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: environment, cwd });
}

async function temporaryDirectory(prefix, operation) {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	try {
		return await operation(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("routes an npm-owned repository", () =>
	temporaryDirectory("one-bin-npm-", async (directory) => {
		await writeFile(join(directory, "package.json"), "{}\n");
		await writeFile(join(directory, "package-lock.json"), "{}\n");
		const result = run(["decide", "--cwd", directory, "--format", "json"]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(JSON.parse(result.stdout).result.selectedManager, "npm");
	}));

test("unknown manager-free directories need context", () =>
	temporaryDirectory("one-bin-unknown-", async (directory) => {
		const result = run(["decide", "--cwd", directory, "--format", "json"]);
		assert.equal(result.status, 2);
		const decision = JSON.parse(result.stdout).result;
		assert.equal(decision.status, "needs-context");
		assert.equal(decision.selectedManager, null);
	}));

test("explicit new personal JavaScript intent defaults to Bun", () =>
	temporaryDirectory("one-bin-bun-", async (directory) => {
		await writeFile(join(directory, "package.json"), "{}\n");
		const result = run(["decide", "--cwd", directory, "--intent", "new-personal-js", "--format", "json"]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(JSON.parse(result.stdout).result.selectedManager, "bun");
	}));

test("rejects different lockfile managers", () =>
	temporaryDirectory("one-bin-conflict-", async (directory) => {
		await writeFile(join(directory, "package-lock.json"), "{}\n");
		await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
		const result = run(["audit", "repo", "--cwd", directory, "--format", "json"]);
		assert.equal(result.status, 2);
		assert.equal(JSON.parse(result.stdout).result.status, "ambiguous");
	}));

test("rejects two lockfiles owned by the same manager", () =>
	temporaryDirectory("one-bin-double-lock-", async (directory) => {
		await writeFile(join(directory, "package-lock.json"), "{}\n");
		await writeFile(join(directory, "npm-shrinkwrap.json"), "{}\n");
		const result = run(["audit", "repo", "--cwd", directory, "--format", "json"]);
		assert.equal(result.status, 2);
		assert.match(JSON.parse(result.stdout).result.conflicts[0], /multiple lockfiles/);
	}));

test("global intent is independent of repository conflicts", () =>
	temporaryDirectory("one-bin-global-", async (directory) => {
		await writeFile(join(directory, "package-lock.json"), "{}\n");
		await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
		const result = run(["decide", "--cwd", directory, "--intent", "global", "--format", "json"]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(JSON.parse(result.stdout).result.selectedManager, "nix");
	}));

test("preserves PATH order including empty and relative components", () =>
	temporaryDirectory("one-bin-path-", async (directory) => {
		const relative = join(directory, "relative");
		await mkdir(relative);
		for (const path of [join(directory, "demo"), join(relative, "demo")]) {
			await writeFile(path, "#!/bin/sh\nexit 0\n");
			await chmod(path, 0o755);
		}
		const environment = { ...process.env, PATH: ":relative" };
		const result = run(["audit", "exe", "demo", "--cwd", directory, "--format", "json"], environment, directory);
		assert.equal(result.status, 1);
		const audit = JSON.parse(result.stdout).result.executables[0];
		const canonicalDirectory = await realpath(directory);
		assert.equal(audit.candidates[0].path, join(canonicalDirectory, "demo"));
		assert.equal(audit.candidates[0].pathIndex, 0);
		assert.equal(audit.candidates[1].path, join(canonicalDirectory, "relative/demo"));
		assert.equal(audit.candidates[1].pathIndex, 1);
	}));

test("configured npm, Bun, and pnpm roots are inventoried", () =>
	temporaryDirectory("one-bin-roots-", async (directory) => {
		const environment = {
			...process.env,
			NPM_CONFIG_PREFIX: join(directory, "npm"),
			BUN_INSTALL: join(directory, "bun"),
			PNPM_HOME: join(directory, "pnpm"),
		};
		const result = run(["audit", "globals", "--cwd", directory, "--format", "json"], environment);
		const paths = JSON.parse(result.stdout).result.inventories.map((item) => item.path);
		assert(paths.includes(join(directory, "npm/bin")));
		assert(paths.includes(join(directory, "bun/bin")));
		assert(paths.includes(join(directory, "pnpm")));
	}));

test("missing executable is a policy finding", () => {
	const result = run(["audit", "exe", "surely-not-a-real-one-bin-command", "--format", "json"]);
	assert.equal(result.status, 1);
	assert.equal(JSON.parse(result.stdout).result.executables[0].status, "missing");
});

test("JSON errors are schema-versioned", () => {
	const result = run(["audit", "repo", "--cwd", "/definitely/missing/one-bin", "--format", "json"]);
	assert.equal(result.status, 3);
	const document = JSON.parse(result.stdout);
	assert.equal(document.schemaVersion, 1);
	assert.equal(document.command, "error");
	assert.equal(document.result.kind, "audit-failure");
});

test("unexpected positional arguments use the usage exit", () => {
	const result = run(["policy", "unexpected", "--format", "json"]);
	assert.equal(result.status, 64);
	assert.equal(JSON.parse(result.stdout).result.kind, "usage");
});


test("repository evidence does not escape the nearest Git root", () =>
	temporaryDirectory("one-bin-boundary-", async (directory) => {
		await writeFile(join(directory, "package-lock.json"), "{}\n");
		const repository = join(directory, "child");
		await mkdir(join(repository, ".git"), { recursive: true });
		const result = run(["decide", "--cwd", repository, "--format", "json"]);
		assert.equal(result.status, 2);
		const decision = JSON.parse(result.stdout).result;
		assert.equal(decision.repositoryRoot, await realpath(repository));
		assert.equal(decision.lockfiles.length, 0);
		assert.equal(decision.selectedManager, null);
	}));

test("global audit never executes PATH-resolved package managers", () =>
	temporaryDirectory("one-bin-no-exec-", async (directory) => {
		const bin = join(directory, "bin");
		const marker = join(directory, "executed");
		await mkdir(bin);
		for (const name of ["npm", "pnpm"]) {
			const path = join(bin, name);
			await writeFile(path, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
			await chmod(path, 0o755);
		}
		const environment = { ...process.env, PATH: bin };
		delete environment.NPM_CONFIG_PREFIX;
		delete environment.PNPM_HOME;
		const result = run(["audit", "globals", "--cwd", directory, "--format", "json"], environment);
		assert([0, 1].includes(result.status), result.stderr);
		assert.equal(existsSync(marker), false);
	}));

test("a mixed npm prefix does not claim unrelated executables", () =>
	temporaryDirectory("one-bin-mixed-prefix-", async (directory) => {
		const prefixBin = join(directory, "prefix/bin");
		const otherBin = join(directory, "other");
		await mkdir(prefixBin, { recursive: true });
		await mkdir(otherBin);
		for (const path of [join(prefixBin, "manual"), join(otherBin, "manual")]) {
			await writeFile(path, "#!/bin/sh\nexit 0\n");
			await chmod(path, 0o755);
		}
		const environment = { ...process.env, NPM_CONFIG_PREFIX: join(directory, "prefix"), PATH: otherBin };
		const result = run(["audit", "globals", "--cwd", directory, "--format", "json"], environment);
		assert.equal(result.status, 1);
		const duplicate = JSON.parse(result.stdout).result.duplicates.find((item) => item.name === "manual");
		assert(duplicate);
		assert.equal(duplicate.candidates.find((item) => item.path === join(prefixBin, "manual")).owner, "unknown");
	}));

test("JSON help is schema-versioned", () => {
	const result = run(["--help", "--format", "json"]);
	assert.equal(result.status, 0);
	const document = JSON.parse(result.stdout);
	assert.equal(document.schemaVersion, 1);
	assert.equal(document.command, "help");
});

test("JSON output is deterministic", () => {
	const first = run(["policy", "--format", "json"]);
	const second = run(["policy", "--format", "json"]);
	assert.equal(first.status, 0);
	assert.equal(second.status, 0);
	assert.equal(first.stdout, second.stdout);
});
