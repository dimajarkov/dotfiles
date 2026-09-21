/**
 * ask_user lets the model ask one multiple-choice question.
 *
 * - The model provides 2 to 5 options.
 * - A free-form "Write my own answer" option is always appended.
 * - Arrow, j/k, or number keys select an option and Enter confirms it.
 * - Escape leaves the free-form editor or dismisses the question.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  ASK_USER_PARAMETER_DESCRIPTIONS,
  ASK_USER_PROMPT_GUIDELINES,
  ASK_USER_PROMPT_SNIPPET,
  ASK_USER_TOOL_DESCRIPTION,
  buildAskUserResultMessage,
} from "./prompt.ts";

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 5;

const OptionSchema = Type.Object({
  label: Type.String({
    description: ASK_USER_PARAMETER_DESCRIPTIONS.optionLabel,
  }),
  description: Type.Optional(
    Type.String({
      description: ASK_USER_PARAMETER_DESCRIPTIONS.optionDescription,
    }),
  ),
});

export const AskUserParams = Type.Object({
  question: Type.String({
    description: ASK_USER_PARAMETER_DESCRIPTIONS.question,
  }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
  }),
});

export type AskUserInput = Static<typeof AskUserParams>;
export type AskUserOutcome = "selected" | "custom" | "dismissed" | "cancelled" | "unavailable";

export interface AskUserDetails {
  question: string;
  options: string[];
  answer: string | null;
  selectedIndex: number | null;
  wasCustom: boolean;
  cancelled: boolean;
  outcome: AskUserOutcome;
}

type SelectionResult =
  | { answer: string; wasCustom: true }
  | { answer: string; wasCustom: false; index: number }
  | null;

type DisplayOption = AskUserInput["options"][number] & {
  isOther?: boolean;
};

function resultText(result: { content: Array<{ type: string; text?: string }> }) {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

export default function askUser(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: ASK_USER_TOOL_DESCRIPTION,
    promptSnippet: ASK_USER_PROMPT_SNIPPET,
    promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
    parameters: AskUserParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const reply = (
        outcome: AskUserOutcome,
        text: string,
        answer: string | null = null,
        wasCustom = false,
        selectedIndex: number | null = null,
      ) => ({
        content: [{ type: "text" as const, text }],
        details: {
          question: params.question,
          options: params.options.map((option) => option.label),
          answer,
          selectedIndex,
          wasCustom,
          cancelled: answer === null,
          outcome,
        } satisfies AskUserDetails,
      });

      if (params.options.length < MIN_OPTIONS || params.options.length > MAX_OPTIONS) {
        throw new Error(
          `ask_user requires between ${MIN_OPTIONS} and ${MAX_OPTIONS} options (got ${params.options.length}). Retry with a valid number of options.`,
        );
      }

      if (signal?.aborted) {
        return reply("cancelled", buildAskUserResultMessage({ kind: "cancelled" }));
      }

      if (ctx.mode !== "tui") {
        return reply("unavailable", buildAskUserResultMessage({ kind: "no-ui" }));
      }

      const allOptions: DisplayOption[] = [
        ...params.options,
        { label: "Write my own answer…", isOther: true },
      ];

      let result: SelectionResult;
      try {
        result = await ctx.ui.custom<SelectionResult>((tui, theme, _keybindings, done) => {
          let optionIndex = 0;
          let editMode = false;
          let cached: { width: number; lines: string[] } | undefined;
          let settled = false;

          const finish = (selection: SelectionResult): void => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", cancel);
            done(selection);
          };

          const cancel = (): void => finish(null);

          signal?.addEventListener("abort", cancel, { once: true });
          if (signal?.aborted) queueMicrotask(cancel);

          const editorTheme: EditorTheme = {
            borderColor: (text) => theme.fg("accent", text),
            selectList: {
              selectedPrefix: (text) => theme.fg("accent", text),
              selectedText: (text) => theme.fg("accent", text),
              description: (text) => theme.fg("muted", text),
              scrollInfo: (text) => theme.fg("dim", text),
              noMatch: (text) => theme.fg("warning", text),
            },
          };
          const editor = new Editor(tui, editorTheme);

          const refresh = (): void => {
            cached = undefined;
            tui.requestRender();
          };

          editor.onSubmit = (value) => {
            const trimmed = value.trim();
            if (trimmed) {
              finish({ answer: trimmed, wasCustom: true });
              return;
            }

            editMode = false;
            editor.setText("");
            refresh();
          };

          const selectOption = (index: number): void => {
            const selected = allOptions[index];
            if (!selected) return;

            if (selected.isOther) {
              optionIndex = index;
              editMode = true;
              refresh();
              return;
            }

            finish({
              answer: selected.label,
              wasCustom: false,
              index: index + 1,
            });
          };

          const handleInput = (data: string): void => {
            if (editMode) {
              if (matchesKey(data, Key.escape)) {
                editMode = false;
                editor.setText("");
                refresh();
                return;
              }

              editor.handleInput(data);
              refresh();
              return;
            }

            if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
              optionIndex = (optionIndex - 1 + allOptions.length) % allOptions.length;
              refresh();
              return;
            }

            if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
              optionIndex = (optionIndex + 1) % allOptions.length;
              refresh();
              return;
            }

            if (data.length === 1 && data >= "1" && data <= String(allOptions.length)) {
              selectOption(Number(data) - 1);
              return;
            }

            if (matchesKey(data, Key.enter)) {
              selectOption(optionIndex);
              return;
            }

            if (matchesKey(data, Key.escape)) finish(null);
          };

          const render = (width: number): string[] => {
            const renderWidth = Math.max(1, width);
            if (cached?.width === renderWidth) return cached.lines;

            const lines: string[] = [];
            const add = (text: string): void => {
              lines.push(truncateToWidth(text, renderWidth));
            };
            const addWrapped = (prefix: string, text: string): void => {
              const prefixWidth = visibleWidth(prefix);
              if (prefixWidth >= renderWidth) {
                add(`${prefix}${text}`);
                return;
              }

              const wrapped = wrapTextWithAnsi(text, Math.max(1, renderWidth - prefixWidth));
              const continuation = " ".repeat(prefixWidth);
              for (let index = 0; index < wrapped.length; index += 1) {
                add(`${index === 0 ? prefix : continuation}${wrapped[index]}`);
              }
            };

            const title = " Question ";
            add(
              theme.fg(
                "accent",
                `─${title}${"─".repeat(Math.max(0, renderWidth - visibleWidth(title) - 1))}`,
              ),
            );
            addWrapped(" ", theme.fg("text", theme.bold(params.question)));
            lines.push("");

            for (let index = 0; index < allOptions.length; index += 1) {
              const option = allOptions[index];
              if (!option) continue;

              const selected = index === optionIndex;
              const prefix = selected ? theme.fg("accent", " ❯ ") : "   ";
              const marker = option.isOther ? "✎" : `${index + 1}.`;
              const label = `${marker} ${option.label}`;
              const color =
                selected || (option.isOther && editMode)
                  ? "accent"
                  : option.isOther
                    ? "muted"
                    : "text";
              addWrapped(prefix, theme.fg(color, label));

              if (option.description) {
                addWrapped("      ", theme.fg("muted", option.description));
              }
            }

            if (editMode) {
              lines.push("");
              addWrapped(" ", theme.fg("muted", "Your answer:"));
              for (const line of editor.render(Math.max(1, renderWidth - 2))) {
                add(` ${line}`);
              }
            }

            lines.push("");
            if (editMode) {
              addWrapped(" ", theme.fg("dim", "Enter submit • Esc back to options"));
            } else {
              addWrapped(
                " ",
                theme.fg(
                  "dim",
                  `↑↓/j/k or 1-${allOptions.length} select • Enter confirm • Esc dismiss`,
                ),
              );
            }
            add(theme.fg("accent", "─".repeat(renderWidth)));

            cached = { width: renderWidth, lines };
            return lines;
          };

          return {
            render,
            invalidate: () => {
              cached = undefined;
            },
            handleInput,
            dispose: () => {
              signal?.removeEventListener("abort", cancel);
            },
          };
        });
      } catch (error) {
        if (signal?.aborted) {
          return reply("cancelled", buildAskUserResultMessage({ kind: "cancelled" }));
        }
        throw error;
      }

      if (signal?.aborted) {
        return reply("cancelled", buildAskUserResultMessage({ kind: "cancelled" }));
      }

      if (!result) {
        return reply("dismissed", buildAskUserResultMessage({ kind: "dismissed" }));
      }

      if (result.wasCustom) {
        return reply(
          "custom",
          buildAskUserResultMessage({
            kind: "custom",
            answer: result.answer,
          }),
          result.answer,
          true,
        );
      }

      const selectedIndex = result.index;
      return reply(
        "selected",
        buildAskUserResultMessage({
          kind: "selected",
          answer: result.answer,
          index: selectedIndex,
        }),
        result.answer,
        false,
        selectedIndex,
      );
    },

    renderCall(args, theme, context) {
      const question = typeof args.question === "string" ? args.question : "";
      let text = theme.fg("toolTitle", theme.bold("ask_user "));
      text += theme.fg("muted", question);

      if (context.expanded && Array.isArray(args.options)) {
        const options = (args.options as DisplayOption[])
          .filter((option) => typeof option?.label === "string")
          .map((option, index) => `${index + 1}. ${option.label}`);
        if (options.length > 0) {
          text += `\n${theme.fg("dim", `  ${options.join("  ")}`)}`;
        }
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as AskUserDetails | undefined;
      if (!details) return new Text(resultText(result), 0, 0);

      if (details.outcome === "unavailable") {
        return new Text(theme.fg("warning", "✗ unavailable"), 0, 0);
      }

      if (details.outcome === "cancelled") {
        return new Text(theme.fg("warning", "✗ cancelled"), 0, 0);
      }

      if (details.outcome === "dismissed" || details.cancelled || details.answer === null) {
        return new Text(theme.fg("warning", "✗ dismissed"), 0, 0);
      }

      if (details.wasCustom) {
        return new Text(
          theme.fg("success", "✓ ") +
            theme.fg("muted", "(wrote) ") +
            theme.fg("accent", details.answer),
          0,
          0,
        );
      }

      const display = details.selectedIndex
        ? `${details.selectedIndex}. ${details.answer}`
        : details.answer;
      return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
    },
  });
}
