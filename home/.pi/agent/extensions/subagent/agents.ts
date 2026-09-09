import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  parseFrontmatter,
} from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface DiscoveredAgent {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: string;
  systemPrompt: string;
  skills: string[];
  spawnTargets: string[];
  source: "user" | "project";
  filePath: string;
}

export interface AgentDiscovery {
  agents: DiscoveredAgent[];
  projectAgentsDirectory?: string;
}

function commaList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function nearestDirectory(cwd: string, suffix: string[]): string | undefined {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, ...suffix);
    if (isDirectory(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function loadDirectory(
  directory: string,
  source: "user" | "project",
): DiscoveredAgent[] {
  if (!isDirectory(directory)) return [];
  const agents: DiscoveredAgent[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) {
      continue;
    }
    const filePath = join(directory, entry.name);
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(
      readFileSync(filePath, "utf8"),
    );
    if (!frontmatter.name || !frontmatter.description) continue;
    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: frontmatter.tools ? commaList(frontmatter.tools) : undefined,
      model: frontmatter.model,
      thinking: frontmatter.thinking,
      systemPrompt: body.trim(),
      skills: commaList(frontmatter.skills),
      spawnTargets: commaList(frontmatter["spawn-targets"]),
      source,
      filePath,
    });
  }
  return agents;
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscovery {
  const userAgents =
    scope === "project" ? [] : loadDirectory(join(getAgentDir(), "agents"), "user");
  const projectAgentsDirectory = nearestDirectory(cwd, [CONFIG_DIR_NAME, "agents"]);
  const projectAgents =
    scope === "user" || !projectAgentsDirectory
      ? []
      : loadDirectory(projectAgentsDirectory, "project");
  const byName = new Map<string, DiscoveredAgent>();
  for (const agent of userAgents) byName.set(agent.name, agent);
  for (const agent of projectAgents) byName.set(agent.name, agent);
  return { agents: [...byName.values()], projectAgentsDirectory };
}

function skillCandidates(cwd: string, skill: string): string[] {
  if (isAbsolute(skill)) return [skill];
  if (skill.includes("/")) return [resolve(cwd, skill)];
  const candidates = [
    join(getAgentDir(), "skills", skill, "SKILL.md"),
    join(homedir(), ".agents", "skills", skill, "SKILL.md"),
  ];
  let current = resolve(cwd);
  while (true) {
    candidates.push(
      join(current, CONFIG_DIR_NAME, "skills", skill, "SKILL.md"),
      join(current, ".agents", "skills", skill, "SKILL.md"),
    );
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return candidates;
}

export function resolveAgentSkills(cwd: string, skills: string[]): string[] {
  return skills.map((skill) => {
    const path = skillCandidates(cwd, skill).find(existsSync);
    if (!path) throw new Error(`Unknown skill for subagent: ${skill}`);
    return path;
  });
}

export function materializeSystemPrompt(
  stateDirectory: string,
  agent: DiscoveredAgent,
): string | undefined {
  if (!agent.systemPrompt) return undefined;
  const directory = join(stateDirectory, "prompts");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const safeName = `${agent.source}-${agent.name}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const contentHash = createHash("sha256")
    .update(agent.filePath)
    .update("\0")
    .update(agent.systemPrompt)
    .digest("hex")
    .slice(0, 20);
  const path = join(directory, `${safeName}-${contentHash}.md`);
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${agent.systemPrompt}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
  return path;
}
