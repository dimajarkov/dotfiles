import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverPythonSkills } from "./python-skills.js";

test("discovers Python-backed skills from a project skill root", () => {
  const project = mkdtempSync(join(tmpdir(), "pi-python-skill-discovery-"));
  const skill = join(project, ".pi", "skills", "test-skill");
  try {
    mkdirSync(join(skill, "src", "test_skill"), { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: test-skill\ndescription: test\n---\n");
    writeFileSync(join(skill, "pyproject.toml"), "[project]\nname = \"test-skill\"\nversion = \"0.1.0\"\n");
    writeFileSync(join(skill, "src", "test_skill", "__init__.py"), "async def run(): pass\n");

    assert.equal(discoverPythonSkills(project).some((entry) => entry.packagePath === skill), false);
    const discovered = discoverPythonSkills(project, { includeProjectSkills: true })
      .find((entry) => entry.packagePath === skill);
    assert.deepEqual(discovered && {
      name: discovered.name,
      importName: discovered.importName,
      packagePath: discovered.packagePath,
      pyprojectPath: discovered.pyprojectPath,
    }, {
      name: "test-skill",
      importName: "test_skill",
      packagePath: skill,
      pyprojectPath: join(skill, "pyproject.toml"),
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("always discovers extension-owned edit and attach-image skills", () => {
  const discovered = discoverPythonSkills(process.cwd());
  const byName = new Map(discovered.map((skill) => [skill.name, skill]));
  assert.equal(byName.get("edit")?.importName, "edit");
  assert.equal(byName.get("attach-image")?.importName, "attach_image");
  assert.match(byName.get("edit")?.packagePath ?? "", /python-skills[/\\]edit$/);
  assert.match(byName.get("attach-image")?.packagePath ?? "", /python-skills[/\\]attach-image$/);
});
