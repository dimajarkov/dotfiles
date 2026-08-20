import assert from "node:assert/strict";
import test from "node:test";
import registerFullscreenNavigation from "./fullscreen-navigation.ts";

type Handler = (event: unknown, context: any) => void;

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

function fakeContext(mode = "tui") {
  const widgets: Array<{ key: string; content: unknown }> = [];
  const notifications: Array<{ message: string; type: string }> = [];
  const context = {
    mode,
    ui: {
      setWidget(key: string, content: unknown) {
        widgets.push({ key, content });
      },
      notify(message: string, type: string) {
        notifications.push({ message, type });
      },
    },
  };

  return { context, widgets, notifications };
}

test("/bottom scrolls the live fullscreen transcript and resumes follow mode", async () => {
  const { events, commands } = fakePi();
  const { context, widgets, notifications } = fakeContext();
  let calls = 0;

  events.get("session_start")!({}, context);
  const widgetFactory = widgets.at(-1)!.content as (tui: unknown) => unknown;
  widgetFactory({
    mode: "fullscreen",
    scrollToBottom() {
      calls += 1;
    },
  });

  await commands.get("bottom")!.handler("", context);

  assert.equal(calls, 1);
  assert.deepEqual(notifications, []);
});

test("/bottom warns instead of coupling regular TUI mode to fullscreen internals", async () => {
  const { events, commands } = fakePi();
  const { context, widgets, notifications } = fakeContext();

  events.get("session_start")!({}, context);
  const widgetFactory = widgets.at(-1)!.content as (tui: unknown) => unknown;
  widgetFactory({ mode: "regular" });
  await commands.get("bottom")!.handler("", context);

  assert.deepEqual(notifications, [
    {
      message: "Bottom navigation is available only in fullscreen TUI mode",
      type: "warning",
    },
  ]);
});

test("session shutdown releases the captured TUI and removes the invisible widget", async () => {
  const { events, commands } = fakePi();
  const { context, widgets, notifications } = fakeContext();

  events.get("session_start")!({}, context);
  const widgetFactory = widgets.at(-1)!.content as (tui: unknown) => unknown;
  widgetFactory({ mode: "fullscreen", scrollToBottom() {} });
  events.get("session_shutdown")!({}, context);
  await commands.get("bottom")!.handler("", context);

  assert.deepEqual(widgets.at(-1), {
    key: "fullscreen-navigation",
    content: undefined,
  });
  assert.equal(notifications.at(-1)?.type, "warning");
});
