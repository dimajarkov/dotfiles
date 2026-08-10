import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KernelPythonSkill } from "./bootstrap.js";

const EXTENSION_SKILLS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "python-skills");

const PYTHON_IMPORT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_SCAN_DEPTH = 8;

export interface DiscoveredPythonSkill extends KernelPythonSkill {
  skillPath: string;
}

function readSkillName(skillFile: string, directory: string): string | undefined {
  try {
    const text = readFileSync(skillFile, "utf8");
    const match = text.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
    const name = match?.[1]?.match(/^name:\s*([A-Za-z0-9_-]+)\s*$/m)?.[1];
    return name || directory;
  } catch {
    return undefined;
  }
}

function importNameForSkill(name: string): string {
  return name.replaceAll("-", "_");
}

function isPythonSkillDirectory(directory: string): DiscoveredPythonSkill | undefined {
  const skillFile = join(directory, "SKILL.md");
  const pyprojectPath = join(directory, "pyproject.toml");
  if (!existsSync(skillFile) || !existsSync(pyprojectPath)) return undefined;

  const name = readSkillName(skillFile, directory.split(/[\\/]/).pop() ?? "skill");
  if (!name) return undefined;
  const importName = importNameForSkill(name);
  if (!PYTHON_IMPORT_PATTERN.test(importName)) return undefined;
  const packagePath = resolve(directory);
  const resolvedPyprojectPath = resolve(pyprojectPath);
  const packageInitPath = join(packagePath, "src", importName, "__init__.py");
  if (!existsSync(packageInitPath)) return undefined;
  return { name, importName, packagePath, pyprojectPath: resolvedPyprojectPath, skillPath: resolve(skillFile) };
}

function scanDirectory(directory: string, depth: number, visited: Set<string>, found: DiscoveredPythonSkill[]): void {
  if (depth > MAX_SCAN_DEPTH || !existsSync(directory)) return;
  let canonical: string;
  try {
    canonical = resolve(directory);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    if (!statSync(canonical).isDirectory()) return;
  } catch {
    return;
  }

  const skill = isPythonSkillDirectory(canonical);
  if (skill) {
    found.push(skill);
    return;
  }

  let entries;
  try {
    entries = readdirSync(canonical, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    scanDirectory(join(canonical, entry.name), depth + 1, visited, found);
  }
}

function ancestorDirectories(cwd: string): string[] {
  const result: string[] = [];
  let current = resolve(cwd);
  for (;;) {
    result.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}

export interface DiscoverPythonSkillsOptions {
  /** Project packages execute build and import code. Require an explicit trust opt-in. */
  includeProjectSkills?: boolean;
}

/** Discover Python-backed skills from trusted user roots and, when opted in, project roots. */
export function discoverPythonSkills(
  cwd: string,
  options: DiscoverPythonSkillsOptions = {},
): DiscoveredPythonSkill[] {
  const projectRoots = options.includeProjectSkills
    ? ancestorDirectories(cwd).flatMap((directory) => [
        join(directory, ".pi", "skills"),
        join(directory, ".agents", "skills"),
      ])
    : [];
  const roots = [
    EXTENSION_SKILLS_ROOT,
    join(homedir(), ".pi", "agent", "skills"),
    join(homedir(), ".agents", "skills"),
    ...projectRoots,
  ];
  const found: DiscoveredPythonSkill[] = [];
  const visited = new Set<string>();
  for (const root of roots) scanDirectory(root, 0, visited, found);

  // Keep the first skill for a colliding import name, matching Pi's precedence.
  const seen = new Set<string>();
  return found.filter((skill) => {
    if (seen.has(skill.importName)) return false;
    seen.add(skill.importName);
    return true;
  });
}
