#!/usr/bin/env node

import {
	accessSync,
	constants,
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const SCHEMA_VERSION = 1;
const EXIT = { ok: 0, policy: 1, ambiguity: 2, auditFailure: 3, usage: 64 };
const LOCKS = new Map([
	["bun.lock", "bun"],
	["bun.lockb", "bun"],
	["npm-shrinkwrap.json", "npm"],
	["package-lock.json", "npm"],
	["pnpm-lock.yaml", "pnpm"],
	["yarn.lock", "yarn"],
]);
const POLICY = {
	invariant: "one executable, one intentional owner",
	stableGlobalTools: "nix",
	newPersonalTypeScript: "bun after explicit new-personal-js intent",
	existingRepository: "declared packageManager and sole lockfile",
};
const HELP = `one-bin: read-only installation ownership router and auditor

Usage:
  one-bin policy [--format json]
  one-bin decide [--cwd PATH] [--intent auto|new-personal-js|global] [--format json]
  one-bin audit repo [--cwd PATH] [--intent auto|new-personal-js|global] [--format json]
  one-bin audit exe EXE... [--cwd PATH] [--format json]
  one-bin audit globals [--cwd PATH] [--format json]
  one-bin audit all [--cwd PATH] [--intent auto|new-personal-js|global] [--exe EXE...] [--format json]
`;

class OneBinError extends Error {
	constructor(message, exitCode, kind) {
		super(message);
		this.exitCode = exitCode;
		this.kind = kind;
	}
}

const byteSort = (left, right) => Buffer.from(left).compare(Buffer.from(right));

function requestedJson(values) {
	return values.some((value, index) => value === "--format=json" || (value === "--format" && values[index + 1] === "json"));
}

function failUsage(message) {
	throw new OneBinError(message, EXIT.usage, "usage");
}

function parseOptions(values, { allowExecutables = false } = {}) {
	const options = { cwd: process.cwd(), intent: "auto", format: "human", executables: [] };
	const positional = [];
	for (let index = 0; index < values.length; index++) {
		const value = values[index];
		if (value === "--cwd") options.cwd = values[++index] ?? failUsage("--cwd requires a value");
		else if (value.startsWith("--cwd=")) options.cwd = value.slice("--cwd=".length);
		else if (value === "--intent") options.intent = values[++index] ?? failUsage("--intent requires a value");
		else if (value.startsWith("--intent=")) options.intent = value.slice("--intent=".length);
		else if (value === "--format") options.format = values[++index] ?? failUsage("--format requires a value");
		else if (value.startsWith("--format=")) options.format = value.slice("--format=".length);
		else if (value === "--exe" && allowExecutables) options.executables.push(values[++index] ?? failUsage("--exe requires a value"));
		else if (value.startsWith("--exe=") && allowExecutables) options.executables.push(value.slice("--exe=".length));
		else if (value.startsWith("-")) failUsage(`Unknown option: ${value}`);
		else positional.push(value);
	}
	if (!["human", "json"].includes(options.format)) failUsage(`Unsupported format: ${options.format}`);
	if (!["auto", "new-personal-js", "global"].includes(options.intent)) failUsage(`Unsupported intent: ${options.intent}`);
	options.cwd = canonicalDirectory(options.cwd);
	return { options, positional };
}

function requireNoPositionals(positional, command) {
	if (positional.length > 0) failUsage(`${command} does not accept positional arguments: ${positional.join(" ")}`);
}

function canonicalDirectory(value) {
	const path = resolve(value);
	if (!existsSync(path)) throw new OneBinError(`Directory does not exist: ${path}`, EXIT.auditFailure, "audit-failure");
	let canonical;
	try {
		canonical = realpathSync(path);
		if (!lstatSync(canonical).isDirectory()) throw new Error("not a directory");
	} catch (error) {
		throw new OneBinError(`Cannot inspect directory ${path}: ${error instanceof Error ? error.message : String(error)}`, EXIT.auditFailure, "audit-failure");
	}
	return canonical;
}

function parsePackageManager(value) {
	if (typeof value !== "string" || value.length === 0) return undefined;
	const separator = value.lastIndexOf("@");
	return { raw: value, manager: separator > 0 ? value.slice(0, separator) : value };
}

function packageManagerAt(path) {
	const packageJson = join(path, "package.json");
	if (!existsSync(packageJson)) return undefined;
	try {
		return parsePackageManager(JSON.parse(readFileSync(packageJson, "utf8")).packageManager);
	} catch (error) {
		return { raw: null, manager: null, error: error instanceof Error ? error.message : String(error) };
	}
}

function repositoryEvidence(cwd) {
	let current = cwd;
	let repositoryRoot;
	let selected;
	for (;;) {
		const isRepositoryRoot = existsSync(join(current, ".git"));
		if (isRepositoryRoot) repositoryRoot = current;
		const lockfiles = [...LOCKS.keys()].filter((name) => existsSync(join(current, name))).sort(byteSort);
		const packageManager = packageManagerAt(current);
		if (!selected && (lockfiles.length > 0 || packageManager !== undefined)) selected = { path: current, lockfiles, packageManager };
		if (isRepositoryRoot) break;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	const projectRoot = selected?.path ?? repositoryRoot ?? cwd;
	const lockfiles = selected?.lockfiles ?? [...LOCKS.keys()].filter((name) => existsSync(join(projectRoot, name))).sort(byteSort);
	const packageManager = selected?.packageManager ?? packageManagerAt(projectRoot);
	return { cwd, repositoryRoot: repositoryRoot ?? null, projectRoot, lockfiles, packageManager: packageManager ?? null };
}

function analyzeRepository(cwd, intent = "auto") {
	const evidence = repositoryEvidence(cwd);
	if (intent === "global") {
		return {
			...evidence,
			selectedManager: "nix",
			reason: "explicit stable machine-wide tool intent",
			conflicts: [],
			status: "ok",
		};
	}
	const lockManagers = [...new Set(evidence.lockfiles.map((name) => LOCKS.get(name)))].sort(byteSort);
	const conflicts = [];
	if (evidence.lockfiles.length > 1) conflicts.push(`multiple lockfiles: ${evidence.lockfiles.join(", ")}`);
	if (evidence.packageManager?.error) conflicts.push(`invalid package.json: ${evidence.packageManager.error}`);
	if (evidence.packageManager?.manager && lockManagers.length === 1 && evidence.packageManager.manager !== lockManagers[0]) {
		conflicts.push(`packageManager ${evidence.packageManager.manager} disagrees with ${lockManagers[0]} lockfile`);
	}
	if (conflicts.length > 0) {
		return { ...evidence, selectedManager: null, reason: "conflicting ownership evidence", conflicts, status: "ambiguous" };
	}
	if (evidence.packageManager?.manager) {
		return { ...evidence, selectedManager: evidence.packageManager.manager, reason: "package.json#packageManager", conflicts, status: "ok" };
	}
	if (lockManagers.length === 1) {
		return { ...evidence, selectedManager: lockManagers[0], reason: "sole lockfile", conflicts, status: "ok" };
	}
	if (intent === "new-personal-js") {
		return { ...evidence, selectedManager: "bun", reason: "explicit new personal JavaScript or TypeScript intent", conflicts, status: "ok" };
	}
	return {
		...evidence,
		selectedManager: null,
		reason: "no package-manager evidence; confirm new-personal-js or provide repository policy",
		conflicts: [],
		status: "needs-context",
	};
}

function isExecutable(path) {
	try {
		accessSync(path, constants.X_OK);
		return !lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

function symlinkChain(path) {
	const chain = [];
	let current = path;
	const seen = new Set();
	for (;;) {
		if (seen.has(current)) break;
		seen.add(current);
		chain.push(current);
		try {
			if (!lstatSync(current).isSymbolicLink()) break;
			const target = readlinkSync(current);
			current = isAbsolute(target) ? target : resolve(dirname(current), target);
		} catch {
			break;
		}
	}
	return chain;
}

function atOrBelow(path, root) {
	return path === root || path.startsWith(`${root}/`);
}

function ownerFor(path, canonicalPath = path) {
	const combined = `${path}\n${canonicalPath}`;
	if (
		combined.includes("/nix/store/") ||
		atOrBelow(path, "/etc/profiles/per-user") ||
		atOrBelow(path, "/run/current-system") ||
		atOrBelow(path, "/nix/var/nix/profiles")
	)
		return "nix";
	if (combined.includes("/.npm-global/") || combined.includes("/npm-global/")) return "npm-global";
	if (combined.includes("/.bun/") || combined.includes("/bun-global/")) return "bun-global";
	if (combined.includes("/pnpm/")) return "pnpm-global";
	if (
		atOrBelow(path, "/opt/homebrew") ||
		atOrBelow(path, "/usr/local/Homebrew") ||
		atOrBelow(path, "/usr/local/Cellar") ||
		atOrBelow(path, "/usr/local/Caskroom") ||
		atOrBelow(canonicalPath, "/opt/homebrew") ||
		atOrBelow(canonicalPath, "/usr/local/Homebrew") ||
		atOrBelow(canonicalPath, "/usr/local/Cellar") ||
		atOrBelow(canonicalPath, "/usr/local/Caskroom")
	)
		return "homebrew";
	if (["/usr/bin", "/bin", "/usr/sbin", "/sbin"].some((root) => atOrBelow(path, root))) return "macos-system";
	if (atOrBelow(path, `${homedir()}/.local`)) return "user-local";
	return "unknown";
}

function pathDirectories(cwd) {
	return (process.env.PATH ?? "").split(":").map((raw, pathIndex) => {
		const expanded = raw === "" ? cwd : raw;
		const path = resolve(cwd, expanded);
		let canonicalPath = path;
		try {
			canonicalPath = realpathSync(path);
		} catch {
			// A missing PATH directory remains observable but has no canonical target.
		}
		return { raw, path, canonicalPath, pathIndex, owner: ownerFor(path, canonicalPath) };
	});
}

function auditExecutable(name, cwd) {
	if (!/^[A-Za-z0-9._+:-]+$/.test(name)) failUsage(`Invalid executable name: ${name}`);
	const candidates = [];
	const seenPaths = new Set();
	for (const directory of pathDirectories(cwd)) {
		const path = join(directory.path, name);
		if (seenPaths.has(path) || !isExecutable(path)) continue;
		seenPaths.add(path);
		const canonicalPath = realpathSync(path);
		candidates.push({
			pathIndex: directory.pathIndex,
			path,
			canonicalPath,
			owner: ownerFor(path, canonicalPath),
			symlinkChain: symlinkChain(path),
		});
	}
	const canonicalTargets = [...new Set(candidates.map((candidate) => candidate.canonicalPath))];
	return {
		name,
		selected: candidates[0] ?? null,
		candidates,
		distinctTargetCount: canonicalTargets.length,
		status: candidates.length === 0 ? "missing" : canonicalTargets.length > 1 ? "duplicate" : "ok",
	};
}

function executableNames(directory) {
	try {
		return readdirSync(directory).filter((name) => isExecutable(join(directory, name))).sort(byteSort);
	} catch {
		return [];
	}
}

function expandConfiguredPath(value, cwd) {
	const expanded = value
		.replace(/^~(?=\/|$)/, homedir())
		.replaceAll("${HOME}", homedir())
		.replaceAll("$HOME", homedir());
	return resolve(cwd, expanded);
}

function npmPrefixFromConfiguration(cwd) {
	if (process.env.NPM_CONFIG_PREFIX) return expandConfiguredPath(process.env.NPM_CONFIG_PREFIX, cwd);
	const npmrc = join(homedir(), ".npmrc");
	try {
		for (const rawLine of readFileSync(npmrc, "utf8").split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#") || line.startsWith(";")) continue;
			const separator = line.indexOf("=");
			if (separator < 0 || line.slice(0, separator).trim().toLowerCase() !== "prefix") continue;
			const value = line.slice(separator + 1).trim();
			if (value) return expandConfiguredPath(value, cwd);
		}
	} catch {
		// An absent or unreadable user npmrc leaves npm ownership unresolved.
	}
	return undefined;
}

function configuredGlobalDirectories(cwd) {
	const npmPrefix = npmPrefixFromConfiguration(cwd);
	const bunInstall = expandConfiguredPath(process.env.BUN_INSTALL || join(homedir(), ".bun"), cwd);
	const pnpmHome = expandConfiguredPath(process.env.PNPM_HOME || join(homedir(), "Library/pnpm"), cwd);
	const configured = [
		{ source: "nix-user-profile", path: `/etc/profiles/per-user/${process.env.USER ?? basename(homedir())}/bin` },
		{ source: "nix-profile", path: join(homedir(), ".nix-profile/bin") },
		{ source: "nix-system", path: "/run/current-system/sw/bin" },
		...(npmPrefix
			? [{ source: "npm-configured-root", path: join(npmPrefix, "bin"), npmModuleRoot: join(npmPrefix, "lib/node_modules") }]
			: []),
		{
			source: "bun-configured-root",
			path: join(bunInstall, "bin"),
			bunRoot: bunInstall,
			bunModuleRoot: join(bunInstall, "install/global/node_modules"),
		},
		{ source: "pnpm-configured-root", path: pnpmHome, pnpmRoot: pnpmHome },
		{ source: "homebrew-arm-root", path: "/opt/homebrew/bin" },
		{ source: "shared-usr-local-bin", path: "/usr/local/bin" },
	];
	for (const directory of pathDirectories(cwd)) configured.push({ source: `path-${directory.pathIndex}`, path: directory.path });
	const seen = new Set();
	return configured.flatMap((item) => {
		const path = resolve(cwd, item.path);
		if (seen.has(path)) return [];
		seen.add(path);
		let canonicalPath = path;
		try {
			canonicalPath = realpathSync(path);
		} catch {
			// Missing configured roots are reported with an empty inventory.
		}
		return [{ ...item, path, canonicalPath }];
	});
}

function inventoryCandidateOwner(inventory, path, canonicalPath) {
	const inferred = ownerFor(path, canonicalPath);
	if (inferred !== "unknown") return inferred;
	if (inventory.npmModuleRoot && atOrBelow(canonicalPath, inventory.npmModuleRoot)) return "npm-global";
	if (
		(inventory.bunModuleRoot && atOrBelow(canonicalPath, inventory.bunModuleRoot)) ||
		(inventory.bunRoot && atOrBelow(path, join(inventory.bunRoot, "bin")))
	)
		return "bun-global";
	if (inventory.pnpmRoot && atOrBelow(path, inventory.pnpmRoot)) return "pnpm-global";
	return "unknown";
}

function auditGlobals(cwd) {
	const inventories = configuredGlobalDirectories(cwd).map((root) => ({ ...root, executables: executableNames(root.path) }));
	const candidatesByName = new Map();
	for (const inventory of inventories) {
		for (const name of inventory.executables) {
			const path = join(inventory.path, name);
			let canonicalPath = path;
			try {
				canonicalPath = realpathSync(path);
			} catch {
				// Keep the visible path if resolution fails.
			}
			const candidates = candidatesByName.get(name) ?? [];
			candidates.push({ owner: inventoryCandidateOwner(inventory, path, canonicalPath), path, canonicalPath });
			candidatesByName.set(name, candidates);
		}
	}
	const duplicates = [...candidatesByName.entries()]
		.flatMap(([name, candidates]) => {
			const distinctTargets = [...new Set(candidates.map((candidate) => candidate.canonicalPath))];
			return distinctTargets.length > 1 ? [{ name, candidates, distinctTargetCount: distinctTargets.length }] : [];
		})
		.sort((left, right) => byteSort(left.name, right.name));
	return { inventories, duplicates, status: duplicates.length > 0 ? "duplicate" : "ok" };
}

function envelope(command, result) {
	return { schemaVersion: SCHEMA_VERSION, command, result };
}

function errorEnvelope(error) {
	const normalized = error instanceof OneBinError
		? error
		: new OneBinError(error instanceof Error ? error.message : String(error), EXIT.auditFailure, "audit-failure");
	return {
		document: envelope("error", { status: "error", kind: normalized.kind, message: normalized.message, exitCode: normalized.exitCode }),
		exitCode: normalized.exitCode,
	};
}

function statusCode(result) {
	const statuses = [];
	function collect(value) {
		if (!value || typeof value !== "object") return;
		if (typeof value.status === "string") statuses.push(value.status);
		for (const child of Object.values(value)) collect(child);
	}
	collect(result);
	if (statuses.includes("ambiguous") || statuses.includes("needs-context")) return EXIT.ambiguity;
	if (statuses.includes("missing") || statuses.includes("duplicate")) return EXIT.policy;
	return EXIT.ok;
}

function renderHuman(document) {
	const { command, result } = document;
	if (command === "policy") {
		console.log("one-bin policy");
		console.log(`  invariant: ${result.invariant}`);
		console.log(`  stable global tools: ${result.stableGlobalTools}`);
		console.log(`  new personal TypeScript: ${result.newPersonalTypeScript}`);
		console.log(`  existing repository: ${result.existingRepository}`);
		return;
	}
	if (command === "decide" || command === "audit repo") {
		console.log(`${result.status}: ${result.projectRoot}`);
		console.log(`  manager: ${result.selectedManager ?? "none"}`);
		console.log(`  reason: ${result.reason}`);
		console.log(`  lockfiles: ${result.lockfiles.join(", ") || "none"}`);
		for (const conflict of result.conflicts) console.log(`  conflict: ${conflict}`);
		return;
	}
	if (command === "audit exe") {
		for (const audit of result.executables) {
			console.log(`${audit.status}: ${audit.name}`);
			for (const candidate of audit.candidates) {
				console.log(`  ${candidate.pathIndex + 1}. [${candidate.owner}] ${candidate.path}`);
				if (candidate.path !== candidate.canonicalPath) console.log(`     -> ${candidate.canonicalPath}`);
			}
		}
		return;
	}
	if (command === "audit globals") {
		for (const inventory of result.inventories) console.log(`${inventory.source}: ${inventory.executables.length} executables at ${inventory.path}`);
		for (const duplicate of result.duplicates) console.log(`duplicate: ${duplicate.name} (${duplicate.candidates.map((candidate) => candidate.owner).join(", ")})`);
		return;
	}
	if (command === "audit all") {
		renderHuman(envelope("audit repo", result.repository));
		renderHuman(envelope("audit exe", result.executables));
		renderHuman(envelope("audit globals", result.globals));
		return;
	}
	if (command === "error") console.error(`${result.kind}: ${result.message}`);
}

function execute(argv) {
	const [command, subcommand, ...rest] = argv;
	if (!command || command === "help" || command === "--help" || command === "-h") return { help: true, exitCode: EXIT.ok };
	let parsed;
	let document;
	if (command === "policy") {
		parsed = parseOptions([subcommand, ...rest].filter((value) => value !== undefined));
		requireNoPositionals(parsed.positional, "policy");
		document = envelope("policy", POLICY);
	} else if (command === "decide") {
		parsed = parseOptions([subcommand, ...rest].filter((value) => value !== undefined));
		requireNoPositionals(parsed.positional, "decide");
		document = envelope("decide", analyzeRepository(parsed.options.cwd, parsed.options.intent));
	} else if (command === "audit" && subcommand === "repo") {
		parsed = parseOptions(rest);
		requireNoPositionals(parsed.positional, "audit repo");
		document = envelope("audit repo", analyzeRepository(parsed.options.cwd, parsed.options.intent));
	} else if (command === "audit" && subcommand === "exe") {
		parsed = parseOptions(rest, { allowExecutables: true });
		const names = [...parsed.positional, ...parsed.options.executables];
		if (names.length === 0) failUsage("audit exe requires at least one executable");
		document = envelope("audit exe", { executables: names.map((name) => auditExecutable(name, parsed.options.cwd)) });
	} else if (command === "audit" && subcommand === "globals") {
		parsed = parseOptions(rest);
		requireNoPositionals(parsed.positional, "audit globals");
		document = envelope("audit globals", auditGlobals(parsed.options.cwd));
	} else if (command === "audit" && subcommand === "all") {
		parsed = parseOptions(rest, { allowExecutables: true });
		requireNoPositionals(parsed.positional, "audit all");
		document = envelope("audit all", {
			repository: analyzeRepository(parsed.options.cwd, parsed.options.intent),
			executables: { executables: parsed.options.executables.map((name) => auditExecutable(name, parsed.options.cwd)) },
			globals: auditGlobals(parsed.options.cwd),
		});
	} else failUsage(`Unknown command: ${argv.join(" ")}`);
	return { document, format: parsed.options.format, exitCode: statusCode(document.result) };
}

const argv = process.argv.slice(2);
const json = requestedJson(argv);
try {
	const result = execute(argv);
	if (result.help && json) console.log(JSON.stringify(envelope("help", { status: "ok", usage: HELP }), null, 2));
	else if (result.help) console.log(HELP);
	else if (result.format === "json") console.log(JSON.stringify(result.document, null, 2));
	else renderHuman(result.document);
	process.exitCode = result.exitCode;
} catch (error) {
	const result = errorEnvelope(error);
	if (json) console.log(JSON.stringify(result.document, null, 2));
	else {
		renderHuman(result.document);
		if (result.exitCode === EXIT.usage) console.error(HELP);
	}
	process.exitCode = result.exitCode;
}
