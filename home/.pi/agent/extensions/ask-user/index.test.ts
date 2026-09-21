import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import registerAskUser, {
  MAX_OPTIONS,
  MIN_OPTIONS,
  type AskUserDetails,
  type AskUserInput,
} from "./index.ts";

type Tool = {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: any;
  executionMode?: string;
  execute: (...args: any[]) => Promise<any>;
  renderCall: (...args: any[]) => Component;
  renderResult: (...args: any[]) => Component;
};

type InteractiveComponent = Component & {
  handleInput(data: string): void;
  dispose?(): void;
};

const INPUT = {
  down: "\x1b[B",
  enter: "\r",
  escape: "\x1b",
};

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const params: AskUserInput = {
  question: "How should this ship?",
  options: [
    { label: "Wait", description: "Hold for another release" },
    { label: "Ship it", description: "Release immediately" },
  ],
};

function registeredTool(): Tool {
  let tool: Tool | undefined;
  registerAskUser({
    registerTool(definition: Tool) {
      tool = definition;
    },
  } as any);
  assert.ok(tool);
  return tool;
}

function plainText(component: Component, width = 160): string {
  return component
    .render(width)
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();
}

function typeText(component: InteractiveComponent, text: string): void {
  for (const character of text) component.handleInput(character);
}

async function executeInTui(
  tool: Tool,
  interact: (component: InteractiveComponent) => void,
  signal?: AbortSignal,
) {
  const tui = {
    terminal: { columns: 160, rows: 40 },
    requestRender() {},
  };
  const ui = {
    custom<T>(factory: (...args: any[]) => InteractiveComponent): Promise<T> {
      return new Promise<T>((resolve) => {
        let component: InteractiveComponent;
        const done = (value: T) => {
          component.dispose?.();
          resolve(value);
        };
        component = factory(tui, theme, {}, done);
        queueMicrotask(() => interact(component));
      });
    },
  };

  return tool.execute("call-1", params, signal, undefined, {
    mode: "tui",
    ui,
  });
}

test("registers the bounded schema and sequential model-facing tool metadata", () => {
  const tool = registeredTool();
  const optionsSchema = tool.parameters.properties.options;

  assert.equal(tool.name, "ask_user");
  assert.equal(tool.executionMode, "sequential");
  assert.equal(optionsSchema.minItems, MIN_OPTIONS);
  assert.equal(optionsSchema.maxItems, MAX_OPTIONS);
  assert.match(tool.description, /single multiple-choice question/i);
  assert.match(tool.promptSnippet ?? "", /free-form answer/i);
  assert.equal(tool.promptGuidelines?.length, 2);
});

test("returns a selected option with structured details", async () => {
  const result = await executeInTui(registeredTool(), (component) => {
    component.handleInput("2");
  });

  assert.equal(result.content[0].text, "User selected option 2: Ship it");
  assert.deepEqual(result.details, {
    question: params.question,
    options: ["Wait", "Ship it"],
    answer: "Ship it",
    selectedIndex: 2,
    wasCustom: false,
    cancelled: false,
    outcome: "selected",
  } satisfies AskUserDetails);
});

test("supports arrow navigation and confirmation", async () => {
  const result = await executeInTui(registeredTool(), (component) => {
    component.handleInput(INPUT.down);
    component.handleInput(INPUT.enter);
  });

  assert.equal(result.details.answer, "Ship it");
  assert.equal(result.details.selectedIndex, 2);
});

test("supports j/k navigation and confirmation", async () => {
  const result = await executeInTui(registeredTool(), (component) => {
    component.handleInput("j");
    component.handleInput("k");
    component.handleInput(INPUT.enter);
  });

  assert.equal(result.details.answer, "Wait");
  assert.equal(result.details.selectedIndex, 1);
});

test("opens the inline editor and submits a trimmed custom answer", async () => {
  const result = await executeInTui(registeredTool(), (component) => {
    component.handleInput("3");
    assert.match(plainText(component), /Your answer:/);
    typeText(component, "  Roll out gradually  ");
    component.handleInput(INPUT.enter);
  });

  assert.equal(result.content[0].text, "User wrote their own answer: Roll out gradually");
  assert.deepEqual(result.details, {
    question: params.question,
    options: ["Wait", "Ship it"],
    answer: "Roll out gradually",
    selectedIndex: null,
    wasCustom: true,
    cancelled: false,
    outcome: "custom",
  } satisfies AskUserDetails);
});

test("Escape leaves the custom editor before it dismisses the question", async () => {
  const result = await executeInTui(registeredTool(), (component) => {
    component.handleInput("3");
    typeText(component, "discard me");
    component.handleInput(INPUT.escape);
    assert.doesNotMatch(plainText(component), /Your answer:/);
    component.handleInput("1");
  });

  assert.equal(result.details.answer, "Wait");
  assert.equal(result.details.outcome, "selected");
});

test("Escape on the options dismisses without implying an answer", async () => {
  const result = await executeInTui(registeredTool(), (component) => {
    component.handleInput(INPUT.escape);
  });

  assert.match(result.content[0].text, /Do not assume an answer/);
  assert.equal(result.details.answer, null);
  assert.equal(result.details.cancelled, true);
  assert.equal(result.details.outcome, "dismissed");
});

test("an abort closes the popup and returns a cancellation", async () => {
  const controller = new AbortController();
  const result = await executeInTui(registeredTool(), () => controller.abort(), controller.signal);

  assert.equal(result.content[0].text, "Cancelled");
  assert.equal(result.details.answer, null);
  assert.equal(result.details.outcome, "cancelled");
});

test("a pre-aborted call never opens UI", async () => {
  const tool = registeredTool();
  const controller = new AbortController();
  controller.abort();
  let customCalls = 0;

  const result = await tool.execute("call-1", params, controller.signal, undefined, {
    mode: "tui",
    ui: {
      custom() {
        customCalls += 1;
      },
    },
  });

  assert.equal(customCalls, 0);
  assert.equal(result.details.outcome, "cancelled");
});

test("non-interactive execution tells the model to ask in plain text", async () => {
  const result = await registeredTool().execute("call-1", params, undefined, undefined, {
    mode: "print",
    ui: {},
  });

  assert.match(result.content[0].text, /Ask the user in plain text instead/);
  assert.equal(result.details.outcome, "unavailable");
});

test("defensively rejects an invalid option count", async () => {
  await assert.rejects(
    registeredTool().execute(
      "call-1",
      { question: "Too few?", options: [{ label: "Only" }] },
      undefined,
      undefined,
      { mode: "print", ui: {} },
    ),
    /requires between 2 and 5 options/,
  );
});

test("renders compact calls and concise outcomes", async () => {
  const tool = registeredTool();
  const context = { expanded: false };
  const collapsed = plainText(tool.renderCall(params, theme, context));
  const expanded = plainText(tool.renderCall(params, theme, { expanded: true }));
  const result = await executeInTui(tool, (component) => {
    component.handleInput("2");
  });
  const renderedResult = plainText(tool.renderResult(result, {}, theme, context));

  assert.equal(collapsed, "ask_user How should this ship?");
  assert.doesNotMatch(collapsed, /1\. Wait/);
  assert.match(expanded, /1\. Wait/);
  assert.equal(renderedResult, "✓ 2. Ship it");
});
