import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export default function customRead(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read",
    label: "owned read",
    description: "Ownership fixture that proves Prime styling does not replace a custom read tool.",
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, args) {
      return {
        content: [{ type: "text", text: `CUSTOM_READ_OWNER:${args.path}` }],
        details: { owner: "fixture" },
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("warning", `CUSTOM OWNER read ${args.path}`), 0, 0);
    },
    renderResult(result, _options, theme) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "missing";
      return new Text(theme.fg("warning", text), 0, 0);
    },
  });
}
