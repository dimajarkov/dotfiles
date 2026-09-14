import assert from "node:assert/strict";
import test from "node:test";
import registerFullscreenNavigation from "./fullscreen-navigation.ts";

type Handler = (event: any, context: any) => void;
type WidgetFactory = (tui: unknown, theme: unknown) => TestComponent;
type TestComponent = {
  render(width: number): string[];
  dispose?(): void;
};

function fakePi() {
  const events = new Map<string, Handler>();
  const commands = new Map<
    string,
    { handler: (args: string, context: any) => Promise<void> }
  >();
  const pi = {
    on(name: string, handler: Handler) {
      events.set(name, handler);
    },
    registerCommand(
      name: string,
      command: { handler: (args: string, context: any) => Promise<void> },
    ) {
      commands.set(name, command);
    },
  };

  registerFullscreenNavigation(pi as any);
  return { events, commands };
}

class FakeFullscreenTui {
  readonly mode = "fullscreen";
  isFollowingOutput = true;
  currentLayout: { lines: string[] } | undefined;
  wheelScrollLines = 1;
  scrollToBottomCalls = 0;
  requestRenderCalls = 0;
  fallbackInputCalls = 0;

  scrollToBottom(): void {
    this.scrollToBottomCalls += 1;
    this.isFollowingOutput = true;
  }

  requestRender(): void {
    this.requestRenderCalls += 1;
  }

  handleViewportInput(_data: string): undefined {
    this.fallbackInputCalls += 1;
    return undefined;
  }
}

function fakeContext(mode = "tui") {
  const widgets: Array<{ key: string; content: unknown }> = [];
  const notifications: Array<{ message: string; type: string }> = [];
  let mountedWidget: TestComponent | undefined;
  const context = {
    mode,
    ui: {
      setWidget(key: string, content: unknown) {
        widgets.push({ key, content });
        if (content === undefined) {
          mountedWidget?.dispose?.();
          mountedWidget = undefined;
        }
      },
      notify(message: string, type: string) {
        notifications.push({ message, type });
      },
    },
  };

  function mountWidget(tui: FakeFullscreenTui): TestComponent {
    const widgetFactory = widgets.at(-1)!.content as WidgetFactory;
    mountedWidget = widgetFactory(tui, {
      bg: (_color: string, text: string) => text,
      fg: (_color: string, text: string) => text,
    });
    return mountedWidget;
  }

  return { context, widgets, notifications, mountWidget };
}

function clickButton(tui: FakeFullscreenTui, line: string, row = 2): void {
  const x = line.indexOf("Jump to bottom") + 1;
  tui.currentLayout = { lines: ["", "", line] };
  const column = x + 1;
  const terminalRow = row + 1;
  const press = `\x1b[<0;${column};${terminalRow}M`;
  const release = `\x1b[<0;${column};${terminalRow}m`;

  assert.deepEqual(tui.handleViewportInput(press), { consume: true });
  assert.deepEqual(tui.handleViewportInput(release), { consume: true });
}

test("renders Claude-style jump control only while scrolled away", () => {
  const { events } = fakePi();
  const { context, mountWidget } = fakeContext();
  const tui = new FakeFullscreenTui();

  events.get("session_start")!({}, context);
  const widget = mountWidget(tui);

  assert.deepEqual(widget.render(80), []);
  tui.isFollowingOutput = false;
  const [line] = widget.render(80);
  assert.ok(line?.includes("Jump to bottom (click) ↓"));

  tui.isFollowingOutput = true;
  assert.deepEqual(widget.render(80), []);
});

test("speeds up fullscreen wheel scrolling", () => {
  const { events } = fakePi();
  const { context, mountWidget } = fakeContext();
  const tui = new FakeFullscreenTui();

  events.get("session_start")!({}, context);
  const widget = mountWidget(tui);
  widget.render(80);

  assert.equal(tui.wheelScrollLines, 2);

  widget.dispose?.();
  assert.equal(tui.wheelScrollLines, 1);
});

test("clicking the control scrolls to the bottom and consumes the mouse gesture", () => {
  const { events } = fakePi();
  const { context, mountWidget } = fakeContext();
  const tui = new FakeFullscreenTui();

  events.get("session_start")!({}, context);
  const widget = mountWidget(tui);
  tui.isFollowingOutput = false;
  const [line] = widget.render(80);
  assert.ok(line);

  clickButton(tui, line);

  assert.equal(tui.scrollToBottomCalls, 1);
  assert.equal(tui.fallbackInputCalls, 0);
  assert.equal(tui.isFollowingOutput, true);
});

test("shows the number of assistant messages completed while scrolled away", () => {
  const { events } = fakePi();
  const { context, mountWidget } = fakeContext();
  const tui = new FakeFullscreenTui();

  events.get("session_start")!({}, context);
  const widget = mountWidget(tui);
  tui.isFollowingOutput = false;
  widget.render(80);

  events.get("message_end")!({ message: { role: "assistant" } }, context);
  events.get("message_end")!({ message: { role: "toolResult" } }, context);

  assert.ok(widget.render(80)[0]?.includes("1 new message (click) ↓"));
});

test("/bottom scrolls the live fullscreen transcript and resumes follow mode", async () => {
  const { events, commands } = fakePi();
  const { context, mountWidget, notifications } = fakeContext();
  const tui = new FakeFullscreenTui();

  events.get("session_start")!({}, context);
  mountWidget(tui);
  await commands.get("bottom")!.handler("", context);

  assert.equal(tui.scrollToBottomCalls, 1);
  assert.deepEqual(notifications, []);
});

test("/bottom warns in regular TUI mode", async () => {
  const { events, commands } = fakePi();
  const { context, widgets, notifications } = fakeContext();

  events.get("session_start")!({}, context);
  const widgetFactory = widgets.at(-1)!.content as WidgetFactory;
  widgetFactory(
    { mode: "regular" },
    {
      bg: (_color: string, text: string) => text,
      fg: (_color: string, text: string) => text,
    },
  );
  await commands.get("bottom")!.handler("", context);

  assert.deepEqual(notifications, [
    {
      message: "Bottom navigation is available only in fullscreen TUI mode",
      type: "warning",
    },
  ]);
});

test("session shutdown restores the viewport handler and removes the widget", () => {
  const { events } = fakePi();
  const { context, widgets, mountWidget } = fakeContext();
  const tui = new FakeFullscreenTui();
  const original = tui.handleViewportInput;

  events.get("session_start")!({}, context);
  const widget = mountWidget(tui);
  tui.isFollowingOutput = false;
  widget.render(80);
  assert.notEqual(tui.handleViewportInput, original);

  events.get("session_shutdown")!({}, context);

  assert.equal(tui.handleViewportInput, FakeFullscreenTui.prototype.handleViewportInput);
  assert.deepEqual(widgets.at(-1), {
    key: "fullscreen-navigation",
    content: undefined,
  });
});
