import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(packageRoot, "package.json"));
const sdkPackageName = "@earendil-works/pi-coding-agent";
const sdkExportPath = "./dist/index.d.ts";

function packageAt(candidate) {
  const directPackage = join(candidate, "package.json");
  const nestedPackage = join(candidate, "coding-agent", "package.json");
  for (const manifestPath of [directPackage, nestedPackage]) {
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name === sdkPackageName) {
        const packageDirectory = dirname(manifestPath);
        return {
          manifest,
          packageDirectory: realpathSync(packageDirectory),
        };
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Cannot read Pi package metadata at ${manifestPath}: ${error.message}`);
      }
    }
  }
  return undefined;
}

function packagesFromExplicitPath(value) {
  const candidate = resolve(value);
  const direct = packageAt(candidate);
  if (direct) return direct;

  for (const packagesDirectory of [
    join(candidate, "packages"),
    join(candidate, "lib", "pi-coding-agent", "packages"),
  ]) {
    const found = packageAt(packagesDirectory);
    if (found) return found;
  }

  throw new Error(
    `PI_TEST_PACKAGES does not contain ${sdkPackageName}; expected its packages directory ` +
      `or an installed Pi prefix: ${candidate}`,
  );
}

function piExecutableFromPath() {
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(entry || ".", "pi");
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue through PATH exactly as command lookup would.
    }
  }
  return undefined;
}

function packagesForInstalledPi() {
  const executable = piExecutableFromPath();
  if (!executable) {
    throw new Error(
      `Cannot find pi on PATH. Set PI_TEST_PACKAGES to the matching Pi packages directory ` +
        `(for example, <profile>/lib/pi-coding-agent/packages).`,
    );
  }

  const candidates = [];
  let directory = dirname(executable);
  while (true) {
    candidates.push(join(directory, "lib", "pi-coding-agent", "packages"));
    candidates.push(join(directory, "packages"));
    candidates.push(directory);

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  for (const candidate of candidates) {
    const found = packageAt(candidate);
    if (found) return found;
  }

  throw new Error(
    `Cannot locate ${sdkPackageName} from the installed pi executable ${executable}. ` +
      `Set PI_TEST_PACKAGES to the matching Pi packages directory ` +
      `(for example, <profile>/lib/pi-coding-agent/packages).`,
  );
}

function publicSdkTypes(sdk) {
  const exportTypes = sdk.manifest.exports?.["."]?.types;
  if (exportTypes !== sdkExportPath || sdk.manifest.types !== sdkExportPath) {
    throw new Error(
      `${sdkPackageName} must publicly export ${sdkExportPath} through both exports["."].types ` +
        `and types; refusing to typecheck against a private or unsupported declaration path.`,
    );
  }

  const declaration = resolve(sdk.packageDirectory, exportTypes);
  if (!declaration.startsWith(`${sdk.packageDirectory}/`) || !existsSync(declaration)) {
    throw new Error(`The public Pi declaration export is missing: ${declaration}`);
  }

  const source = readFileSync(declaration, "utf8");
  if (!/export\s+(?:type\s+)?(?:\{[^}]*\bUserRequestScope\b|\bUserRequestScope\b)/s.test(source)) {
    const version = sdk.manifest.version ? ` (version ${sdk.manifest.version})` : "";
    throw new Error(
      `The selected ${sdkPackageName}${version} does not publicly export UserRequestScope ` +
        `from ${sdkExportPath}. Use the matching patched Pi profile or set PI_TEST_PACKAGES ` +
        `to its packages directory; the native adapter check will not be skipped.`,
    );
  }

  return realpathSync(declaration);
}

function typeRootFor(packagePath) {
  return dirname(dirname(packagePath));
}

function runCompiler(typescriptEntry, args) {
  const result = spawnSync(process.execPath, [typescriptEntry, ...args], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function main() {
  const sdk = process.env.PI_TEST_PACKAGES
    ? packagesFromExplicitPath(process.env.PI_TEST_PACKAGES)
    : packagesForInstalledPi();
  const declaration = publicSdkTypes(sdk);

  let typescriptEntry;
  let bunTypes;
  let nodeTypes;
  try {
    typescriptEntry = require.resolve("typescript/bin/tsc");
    bunTypes = require.resolve("@types/bun/package.json");
    nodeTypes = require.resolve("@types/node/package.json", {
      paths: [dirname(bunTypes)],
    });
  } catch (error) {
    throw new Error(
      `Cannot resolve the package's declared TypeScript and Bun/Node type dependencies. ` +
        `Run bun install before typechecking. ${error.message}`,
    );
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "hunk-turn-review-typecheck-"));
  const configPath = join(temporaryDirectory, "tsconfig.json");
  const config = {
    extends: join(packageRoot, "tsconfig.json"),
    compilerOptions: {
      paths: { [sdkPackageName]: [declaration] },
      typeRoots: [...new Set([typeRootFor(bunTypes), typeRootFor(nodeTypes)])],
      types: ["bun", "node"],
    },
  };

  try {
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const coreResult = runCompiler(typescriptEntry, ["--project", configPath]);
    if (coreResult !== 0) return coreResult;
    return runCompiler(typescriptEntry, ["--project", join(packageRoot, "tsconfig.adapters.json")]);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`typecheck: ${error.message}`);
  process.exitCode = 1;
}
