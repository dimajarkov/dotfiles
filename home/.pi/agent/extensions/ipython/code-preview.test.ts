import assert from "node:assert/strict";
import test from "node:test";
import { previewIpythonCode } from "./code-preview.js";

const cases = [
  {
    name: "prefers a meaningful Python effect over imports",
    code: "from pathlib import Path\np = Path('src/app.ts')\ntext = p.read_text()\nprint(text[:200])",
    expected: "text = p.read_text()",
    language: "python",
  },
  {
    name: "summarizes project test commands in bash cells",
    code: "%%bash\nset -e\ncd repo\nuv run pytest tests/test_api.py -q",
    expected: "pytest tests/test_api.py -q",
    language: "bash",
  },
  {
    name: "redacts secrets from previews",
    code: "api_token = 'secret-value'\nclient.connect(api_token)",
    expected: "client.connect(api_token)",
    language: "python",
  },
] as const;

for (const entry of cases) {
  test(entry.name, () => {
    const preview = previewIpythonCode(entry.code);
    assert.equal(preview.language, entry.language);
    assert.equal(preview.text, entry.expected);
    assert.doesNotMatch(preview.text, /secret-value/);
  });
}
