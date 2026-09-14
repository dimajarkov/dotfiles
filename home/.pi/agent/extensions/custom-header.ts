/**
 * Straw Hat Luffy startup header.
 * Run /reload to apply changes, or /builtin-header to restore Pi's default.
 */
import { type ExtensionAPI, type Theme, VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

// Original pixel portrait: straw hat, messy hair, cheek scar, grin, and red vest.
// Each character is one square pixel; dots leave the terminal background visible.
const LUFFY = [
  "...............kkkkkkkkkk...............",
  ".............kkyylllllllykkk............",
  "............klllllylllllllyyk...........",
  "...........kllylllyllllyllllyk..........",
  "..........kyllyllllllllyllllyyk.........",
  "..........klollllolllolllllolyk.........",
  "..........kyoyyyyoyyyoyyyoyoyyyk........",
  ".........kkkkkkkkkkkkkkkkkkkkkyk.......",
  ".........kkrrrrrrrrrrrrrrrrrrrkk.......",
  "......kkkkkkkkkkkkkkkkkkkkkkkkkkk......",
  "...kkkyyllllllllllllllllllllllllykkkk..",
  ".kkyllllyyyyyyyyyyyyyyyyyyyyyyyyllllykk",
  "kkyyyooyyyooyyyooyyyooyyyooyyyooyyyooyyk",
  "..kkooooooooooooooooooooooooooooooookkk",
  "......kkkkkkkkkkkkkkkkkkkkkkkkkkkkk....",
  ".........kkkkkkksskkskkkskkkkkk........",
  ".........kkkkskksskssskssskskkk........",
  "........kkkkkskkksssssskkkkskkkk.......",
  "........kkkkskwwwksssskwwwkskkkkk......",
  ".......kksskskwkwksssskwkwkskssk.......",
  "........kstkskwwwksstskwwwksktsk.......",
  "........kstktskkksstssskkhshktsk.......",
  "........kksktssssssttssshhhhhsk........",
  "..........kkstkssssssssskkshkk.........",
  "...........kstkkkkkkkkkkwkskk..........",
  "............ktskwwwwwwwwkstk...........",
  "............kstkkwwwwwwwktk............",
  ".............kstskkkkkkktsk............",
  "..............kkttttttttkk.............",
  "...............tkkkkkkkkt..............",
  "............kkkttttttttttkkk...........",
  ".........kkkrrrkttttttttkrrrkkk........",
  "........krrrrrrksstttttskrrrrrrk.......",
  ".......kkrdrrrrrkssstsskrrrrdrrkk......",
  "......kkrrdrrrrrksssssskrrrrdrrrkk.....",
  ".....kskrdrrryyrksssssskrrrrrdrrksk....",
  ".....kskrdrrryyrksssssskrrrrrdrrkssk...",
  "....kkkkkdkkkkkkkkkkkkkkkkkkkdkkkkkk...",
];

// Fixed illustration colors preserve Luffy's identity in light and dark themes.
const PALETTE: Record<string, string | undefined> = {
  k: "48;44;54", // Ink / hair
  h: "75;65;68", // Hair highlight / scar
  y: "233;185;87", // Straw
  l: "255;219;131", // Sunlit straw
  o: "173;120;61", // Straw shadow
  r: "215;71;67", // Ribbon / vest
  d: "158;51;57", // Red shadow
  s: "255;195;146", // Skin
  t: "223;149;109", // Skin shadow
  w: "255;247;230", // Eyes / teeth
};

const ART_WIDTH = Math.max(...LUFFY.map((row) => row.length));

function renderPortrait(): string[] {
  const lines: string[] = [];
  // Two square pixels per terminal cell, using Unicode half blocks, not images.
  for (let y = 0; y < LUFFY.length; y += 2) {
    let line = "";
    for (let x = 0; x < ART_WIDTH; x++) {
      const top = PALETTE[LUFFY[y]?.[x] ?? "."];
      const bottom = PALETTE[LUFFY[y + 1]?.[x] ?? "."];
      if (!top && !bottom) {
        line += " ";
      } else {
        const fg = `\x1b[38;2;${top ?? bottom}m`;
        const bg = top && bottom ? `\x1b[48;2;${bottom}m` : "\x1b[49m";
        line += `${fg}${bg}${top ? "▀" : "▄"}\x1b[0m`;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

// The portrait palette never changes, so encode it just once per extension load.
const PORTRAIT = renderPortrait();

function buildHeader(theme: Theme, width: number): string[] {
  // A compact line drawing keeps the face intact in narrow split panes.
  const art =
    width >= ART_WIDTH
      ? PORTRAIT
      : [
          theme.fg("warning", "     .-~~~-."),
          theme.fg("warning", "    /_/_/_/_\\"),
          theme.fg("error", "    |=======|"),
          theme.fg("warning", " .--'-------'--."),
          theme.fg("warning", " '---.") + theme.fg("text", "vvvvv") + theme.fg("warning", ".---'"),
          theme.fg("text", "     ( ^ ^ )"),
          theme.fg("text", "     | \\_/+|"),
          theme.fg("text", "      '---'"),
        ];
  const padding = width >= ART_WIDTH + 2 ? "  " : "";
  const label = theme.bold(theme.fg("accent", "pi")) + theme.fg("dim", ` v${VERSION}`);
  return ["", ...art.map((line) => padding + line), "", padding + label].map((line) =>
    truncateToWidth(line, Math.max(0, width), ""),
  );
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((_tui, theme) => ({
      render: (width: number) => buildHeader(theme, width),
      // Theme-dependent text is rebuilt on every render; the portrait is fixed.
      invalidate() {},
    }));
  });

  pi.registerCommand("builtin-header", {
    description: "Restore the built-in startup header",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;
      ctx.ui.setHeader(undefined);
      ctx.ui.notify("Built-in header restored", "info");
    },
  });
}
