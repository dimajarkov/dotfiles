import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "typebox") {
			return { url: "web-fetch-test:typebox", shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (url === "web-fetch-test:typebox") {
			return {
				format: "module",
				source: "export const Type = new Proxy({}, { get: () => (...args) => ({}) });",
				shortCircuit: true,
			};
		}
		return nextLoad(url, context);
	},
});

const { default: webFetchExtension } = await import("../index.ts");

const theme = {
	fg: (_color, text) => `\x1b[32m${text}\x1b[0m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
};

function registeredTool() {
	let tool;
	webFetchExtension({ registerTool: (registered) => (tool = registered) });
	assert.ok(tool);
	return tool;
}

test("web fetch renderers strip untrusted terminal controls without mutating results", () => {
	const tool = registeredTool();
	const args = {
		url: "https://example.test/\x1b]52;c;CALL-CONTROL\x07\nspoof\u202eline",
	};
	const savedArgs = structuredClone(args);
	const call = tool.renderCall(args, theme, { lastComponent: undefined })
		.render(120)
		.join("\n");
	assert.match(stripTerminalSequences(call), /fetch https:\/\/example\.test\/ spoofline/u);
	assert.doesNotMatch(call, /CALL-CONTROL|\x1b\]52;|\u202e/u);
	assert.match(call, /\x1b\[32m/u);
	assert.deepEqual(args, savedArgs);

	const result = {
		content: [
			{
				type: "text",
				text: "before\x1b]52;c;CONTENT-CONTROL\x07after\n\x1b]8;;command:unsafe\x1b\\run\x1b]8;;\x1b\\",
			},
		],
		details: {
			title: "Title\x1b]52;c;TITLE-CONTROL\x07\nforged\u2066row\u2069",
			chars: 42,
		},
	};
	const savedResult = structuredClone(result);
	const rendered = tool.renderResult(
		result,
		{ expanded: true, isPartial: false },
		theme,
		{ isError: false, lastComponent: undefined },
	)
		.render(120)
		.join("\n");
	assert.match(stripTerminalSequences(rendered), /Title forgedrow \(42 chars\)/u);
	assert.match(stripTerminalSequences(rendered), /beforeafter/u);
	assert.doesNotMatch(
		rendered,
		/(?:CONTENT|TITLE)-CONTROL|command:unsafe|\x1b\]52;|\x1b\]8;;command:/u,
	);
	assert.match(rendered, /\x1b\[32m/u);
	assert.deepEqual(result, savedResult);

	const error = {
		content: [
			{
				type: "text",
				text: "failed\x1b]52;c;ERROR-CONTROL\x07 safely",
			},
		],
		details: {},
	};
	const savedError = structuredClone(error);
	const renderedError = tool.renderResult(
		error,
		{ expanded: false, isPartial: false },
		theme,
		{ isError: true, lastComponent: undefined },
	)
		.render(120)
		.join("\n");
	assert.match(stripTerminalSequences(renderedError), /failed safely/u);
	assert.doesNotMatch(renderedError, /ERROR-CONTROL|\x1b\]52;/u);
	assert.deepEqual(error, savedError);
});
