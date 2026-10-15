# Chrome for Testing for native QA

Research date: 2026-10-15.
Scope: whether a dedicated Chrome for Testing application is a better QA target than another regular Chrome process with a disposable profile.
This investigation installed nothing, launched no browsers, and made no runtime or browser-policy changes.

## Recommendation

Prefer a version-pinned Chrome for Testing app with an explicit disposable task-owned profile for this QA workflow, subject to a small native Computer Use acquisition test.
Its distinct macOS application identity directly addresses a plausible source of the observed regular-Chrome instance selection ambiguity.
That is an engineering inference, not evidence that it fixes the Codex connection.
The previous failures establish wrong-instance selection, not a confirmed internal root cause.

## Established practice

Google describes Chrome for Testing as a Chrome flavor dedicated to automation, integrated with Chrome releases, available as versioned binaries, and without automatic updates.
This lets a project pin its browser version for repeatable runs.
Google explicitly recommends Chrome for Testing for browser automation in its remote-debugging guidance.
Sources: [Chrome for Testing](https://developer.chrome.com/docs/automation-and-testing/chrome-for-testing), [remote-debugging changes](https://developer.chrome.com/blog/remote-debugging-port).

Mainstream tool defaults demonstrate established adoption, without establishing a statistical claim about all developers:

- Puppeteer downloads a compatible Chrome for Testing binary by default: [installation documentation](https://pptr.dev/guides/installation).
- Selenium Manager can automatically download and cache Chrome for Testing, including requested browser versions: [automated browser management](https://www.selenium.dev/documentation/selenium_manager/#automated-browser-management).
- Playwright switched to Chrome for Testing builds in version 1.57: [release notes](https://playwright.dev/docs/release-notes#version-157).
- Chrome DevTools MCP explicitly supports regular Google Chrome and Chrome for Testing: [supported browsers](https://github.com/ChromeDevTools/chrome-devtools-mcp#supported-browsers).

Clean test state is a separate, complementary practice.
Playwright creates isolated browser contexts with separate cookies and storage for each test; Selenium recommends a fresh browser per test.
These approaches do not require Google profile sign-in.
Sources: [Playwright isolation](https://playwright.dev/docs/browser-contexts), [Selenium fresh browser per test](https://www.selenium.dev/documentation/test_practices/encouraged/fresh_browser_per_test/).

## Why the dedicated macOS app matters here

Chromium documents these application bundle identifiers:

| Application | Bundle identifier |
| --- | --- |
| Google Chrome Stable | `com.google.Chrome` |
| Chrome for Testing | `com.google.chrome.for.testing` |

The same document lists their default user-data directory as `~/Library/Application Support/Google/Chrome/`.
Therefore a different app identity alone must not be treated as profile isolation.
Continue using an explicit new private `--user-data-dir`, with no copied personal profile or Google sign-in.
Source: [Chromium Mac flavors](https://chromium.googlesource.com/chromium/src.git/+/refs/heads/main/docs/mac/flavors_of_chrome.md).

In the current task, regular Chrome native acquisition repeatedly returned a code-review window rather than the owned synthetic QA window, including after human foregrounding and plugin reconnection.
A unique CfT application target could remove that particular application-identity ambiguity.
Multiple CfT processes could still present their own selection ambiguity, so begin with one owned native QA instance and verify its URL and rendered marker before input.
These are local observations and proposed mitigations, not a confirmed diagnosis of Codex internals.

## Codex compatibility boundary

OpenAI documents general native application control and separately documents extension-backed browser control.
The browser-extension documentation names supported Chromium browsers but does not explicitly promise Chrome for Testing support.
General CDP compatibility, or support in Chrome DevTools MCP, does not establish compatibility with Codex's browser extension.
Sources: [Computer Use](https://learn.chatgpt.com/docs/computer-use), [browser extension](https://learn.chatgpt.com/docs/chrome-extension).

First verify that native Computer Use can acquire the exact CfT app, observe the owned synthetic page, and complete a screenshot/click/readback check while regular Chrome remains open.
Only a passing live check establishes that it resolves this task's blocker.
Keep CDP diagnostics distinct from the native visual acceptance evidence required by the Pi work.

## Tradeoffs and proposed integration

The lack of automatic updates improves reproducibility but requires deliberate version updates.
Google limits its recommendation to testing and trustworthy content; keep personal browsing in the everyday browser.
Source: [Chrome for Testing](https://developer.chrome.com/docs/automation-and-testing/chrome-for-testing).

For this dotfiles setup, the proposed durable integration is a single declared installation owner with a pinned official build, a stable app path, and the repository QA owner creating disposable profiles.
Retain existing task ownership checks and exact-resource cleanup.
Do not add personal profile state or change the default browser to make QA work.
These are recommendations; this research does not activate them or claim end-to-end acceptance.
