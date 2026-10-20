# Dmitri's Lavish artifact preferences

This file owns Dmitri's personal authoring defaults for every newly generated or substantially revised Lavish HTML artifact.
Apply these defaults unless the current request explicitly calls for a different experience, such as a faithful product UI mockup, a printable document, or slides.
These are agent authoring instructions, not Lavish renderer settings; they do not transform existing artifacts automatically.
Continue to use the CLI's design and matching playbook guidance for technical requirements and the subject project's visual design.

## Overview first, detail on demand

- Start with the artifact's purpose, a concise takeaway, and a small set of meaningful components or topics.
- Keep important risks, unresolved decisions, and requested next actions visible as short summaries at the relevant overview level.
- Make each component with substantial detail open a focused view within the artifact instead of placing all explanations on the initial page.
- At each level, show the selected topic's explanation and immediate children; reveal implementation details, evidence, and deeper tradeoffs only when selected.
- Give components descriptive labels and a short preview so the user can choose what to explore without opening everything.
- Keep genuinely small artifacts simple; use breadcrumbs when there is a real hierarchy rather than inventing empty navigation levels.

## Breadcrumb navigation

- Use a persistent, clearly labelled breadcrumb navigation region on every drill-down view, for example `Plan > Architecture > Feedback delivery > Retry behavior`.
- Make every ancestor navigable, identify the current location with `aria-current="page"`, and provide an obvious route back to the overview.
- Prefer replacing the main content with a focused page-like view over stacking sheets or modals.
- Reserve sheets for brief supplementary context; substantial topics belong in the breadcrumb hierarchy.
- Keep the experience in one portable HTML file by default, using stable hash routes and no server-dependent routing.
- Support direct opening and refreshing of a nested hash route, browser Back/Forward, and a safe overview fallback for unknown routes.
- Preserve each view's scroll position when returning to it, and keep the current route across reloads when it remains valid.

## Interaction and review

- Make drill-down controls keyboard accessible with visible focus states and meaningful accessible names.
- Move focus to the new view's heading after an in-artifact navigation so keyboard and screen-reader users can follow the transition.
- Use native buttons for view-changing actions and follow current CLI guidance for navigation links and custom interactive diagram nodes so clicks navigate rather than opening annotation cards.
- Keep the actual explanatory content annotatable, with stable element identities where practical.
- Breadcrumbs must wrap or otherwise remain usable on narrow screens without horizontal page overflow.
- Navigation is local exploration, not feedback: changing views must not queue prompts or send messages to the agent.

## Authoring acceptance check

Before handing off an artifact, verify the applicable items:

1. The opening view communicates the purpose and key decisions without exposing all detailed sections.
2. Selecting a component reveals only its focused context and immediate children, with working breadcrumbs back to its ancestors.
3. A nested route opens directly, survives refresh, and participates correctly in Back/Forward navigation.
4. Keyboard users can activate drill-down controls and find focus in the new view; returning restores the prior reading position.
5. Important risks remain discoverable in overview summaries, navigation works at phone widths, and exploration does not send feedback.
6. The artifact's local navigation also works when its HTML file is opened without Lavish running.

Use the approved browser route for rendered interaction checks and report any checks that could not be performed rather than claiming they passed.
