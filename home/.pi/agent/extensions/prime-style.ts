import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";

const EDITOR_BASE_PADDING = 3;
const EDITOR_SURFACE_PADDING = 2;
const PROMPT_PREFIX_WIDTH = 2;

const START_HINTS = [
  'Try "refactor @<filepath>"',
  'Try "fix bugs in @<filepath>"',
  'Try "add tests for @<filepath>"',
  'Try "explain how @<filepath> works"',
  'Try "improve performance in @<filepath>"',
] as const;

type AppTheme = ExtensionContext["ui"]["theme"];
type Keybindings = ConstructorParameters<typeof CustomEditor>[2];
type Background = "userMessageBg" | "customMessageBg";

function fitLine(line: string, width: number): string {
  const fitted = truncateToWidth(line, width, "");
  return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

function withBackground(theme: AppTheme, background: Background, line: string): string {
  // The legacy Pi editor uses a full SGR reset for its cursor. Reapply the
  // surface after those resets so the fill remains continuous.
  return line
    .split("\x1b[0m")
    .map((segment) => theme.bg(background, segment))
    .join("\x1b[0m");
}

function isEditorBorder(line: string, width: number): boolean {
  const plain = stripTerminalSequences(line);
  const compact = plain.replace(/ /g, "");
  return (
    (visibleWidth(plain) >= width && /^─+$/.test(compact)) ||
    (plain.includes("───") && /[↑↓]/.test(plain))
  );
}

function chooseStartHint(): string {
  return START_HINTS[Math.floor(Math.random() * START_HINTS.length)] ?? START_HINTS[0];
}

/**
 * Prime Agent's editor is a filled surface with a subtle prompt gutter.
 *
 * Pi 0.84 predates the surface-aware editor used by Prime Agent, so this
 * adapter keeps Pi's editing/autocomplete behavior and only repaints its
 * rendered rows to match Prime's layout.
 */
class PrimeEditor extends CustomEditor {
  private readonly getAppTheme: () => AppTheme;
  private readonly placeholder: string;

  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: Keybindings,
    getAppTheme: () => AppTheme,
    placeholder: string,
  ) {
    super(tui, editorTheme, keybindings, { paddingX: EDITOR_BASE_PADDING });
    this.getAppTheme = getAppTheme;
    this.placeholder = placeholder;
  }

  override setPaddingX(_padding: number): void {
    // Prime clamps filled editors to two visible columns of horizontal inset.
    super.setPaddingX(EDITOR_BASE_PADDING);
  }

  override render(width: number): string[] {
    const raw = super.render(width);
    if (width < EDITOR_SURFACE_PADDING * 2 + PROMPT_PREFIX_WIDTH + 2 || raw.length < 3) {
      return raw;
    }

    const bottomBorderIndex = raw.findIndex((line, index) => index > 0 && isEditorBorder(line, width));
    if (bottomBorderIndex < 0) {
      return raw;
    }

    const appTheme = this.getAppTheme();
    const contentWidth = Math.max(1, width - EDITOR_SURFACE_PADDING * 2);
    const inputWidth = Math.max(1, contentWidth - PROMPT_PREFIX_WIDTH);
    const contentLines = raw.slice(1, bottomBorderIndex);
    const output = [withBackground(appTheme, "userMessageBg", " ".repeat(width))];

    contentLines.forEach((line, index) => {
      const body =
        index === 0 && this.getText().length === 0
          ? this.renderPlaceholder(inputWidth)
          : sliceByColumn(line, EDITOR_BASE_PADDING, inputWidth);
      const prefix = index === 0 ? " >  " : " ".repeat(EDITOR_SURFACE_PADDING + PROMPT_PREFIX_WIDTH);
      const rendered = fitLine(`${prefix}${body}${" ".repeat(EDITOR_SURFACE_PADDING)}`, width);
      output.push(withBackground(appTheme, "userMessageBg", rendered));
    });

    output.push(withBackground(appTheme, "userMessageBg", " ".repeat(width)));

    // Keep Pi's autocomplete rows usable while giving them Prime's panel fill.
    for (const line of raw.slice(bottomBorderIndex + 1)) {
      output.push(withBackground(appTheme, "customMessageBg", fitLine(line, width)));
    }

    return output;
  }

  private renderPlaceholder(width: number): string {
    const placeholder = truncateToWidth(this.placeholder, Math.max(0, width - 1), "");
    const cursor = `${this.focused ? CURSOR_MARKER : ""}\x1b[7m \x1b[27m`;
    const styled = cursor + this.getAppTheme().fg("dim", placeholder);
    return styled + " ".repeat(Math.max(0, width - visibleWidth(styled)));
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    // Prime Agent uses one dark brand theme rather than Pi's telemetry-oriented
    // light/dark theme pair. Keep this conditional so the extension is safe if
    // the theme file has not been linked yet.
    if (ctx.ui.getTheme("prime")) {
      ctx.ui.setTheme("prime");
    }

    const placeholder = chooseStartHint();
    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) =>
      new PrimeEditor(tui, editorTheme, keybindings, () => ctx.ui.theme, placeholder),
    );
  });
}
