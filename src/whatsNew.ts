// The version-gated "What's New" popup. On VS Code startup (see the
// `onStartupFinished` activation event) `showWhatsNewIfNeeded` compares the
// installed extension version against the last version the user has seen
// (persisted in globalState) and, on an upgrade, opens a webview panel listing
// the changelog entries newer than what they last saw. Fresh installs stay
// silent. `showWhatsNewCommand` backs the manual "Show What's New" palette
// command and always shows the full changelog. Pure logic lives in
// `whatsNewCore.ts`.
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ChangelogEntry,
  changelogToHtml,
  parseChangelog,
  selectNewEntries,
} from "./whatsNewCore";

const LAST_SHOWN_KEY = "lastShownVersion";
const REPO_CHANGELOG_URL =
  "https://github.com/loumalouomega/VSCode-MDPA-Preview/blob/master/CHANGELOG.md";

function currentVersion(context: vscode.ExtensionContext): string {
  const v = context.extension.packageJSON?.version;
  return typeof v === "string" ? v : "0.0.0";
}

function readChangelog(context: vscode.ExtensionContext): string | undefined {
  const file = path.join(context.extensionPath, "CHANGELOG.md");
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  } catch {
    /* unreadable — treat as absent */
  }
  return undefined;
}

/**
 * Show the "What's New" panel if the extension has been upgraded since the user
 * last saw it. Silent on first install and when there is nothing newer to show.
 * Fire-and-forget from `activate`.
 */
export async function showWhatsNewIfNeeded(
  context: vscode.ExtensionContext
): Promise<void> {
  const enabled = vscode.workspace
    .getConfiguration("kratos")
    .get<boolean>("showWhatsNew", true);
  if (!enabled) return;

  const current = currentVersion(context);
  const lastShown = context.globalState.get<string>(LAST_SHOWN_KEY);
  if (lastShown === current) return;

  // Fresh install: remember the version but don't greet a brand-new user.
  if (!lastShown) {
    await context.globalState.update(LAST_SHOWN_KEY, current);
    return;
  }

  const text = readChangelog(context);
  const newEntries = text
    ? selectNewEntries(parseChangelog(text), lastShown)
    : [];
  // Even with nothing to show (e.g. a downgrade or missing changelog), advance
  // the marker so the check doesn't run again for this version.
  await context.globalState.update(LAST_SHOWN_KEY, current);
  if (!newEntries.length) return;

  openWhatsNewPanel(context, newEntries, { current, sinceVersion: lastShown });
}

/** Manual palette command: always open the panel with the full changelog. */
export function showWhatsNewCommand(context: vscode.ExtensionContext): void {
  const text = readChangelog(context);
  if (!text) {
    void vscode.window.showInformationMessage(
      "No changelog is available for this extension."
    );
    return;
  }
  openWhatsNewPanel(context, parseChangelog(text), {
    current: currentVersion(context),
  });
}

function openWhatsNewPanel(
  context: vscode.ExtensionContext,
  entries: ChangelogEntry[],
  opts: { current: string; sinceVersion?: string }
): void {
  const panel = vscode.window.createWebviewPanel(
    "kratos.whatsNew",
    "What's New — Kratos MDPA Preview",
    vscode.ViewColumn.Active,
    { enableScripts: false, retainContextWhenHidden: false }
  );
  panel.webview.html = whatsNewHtml(entries, opts);
  context.subscriptions.push(panel);
}

function whatsNewHtml(
  entries: ChangelogEntry[],
  opts: { current: string; sinceVersion?: string }
): string {
  const csp = [
    `default-src 'none'`,
    `style-src 'unsafe-inline'`,
    `img-src https: data:`,
  ].join("; ");
  const subtitle = opts.sinceVersion
    ? `New since v${esc(opts.sinceVersion)} — you're now on v${esc(opts.current)}`
    : `Version ${esc(opts.current)}`;
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>What's New</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 0 24px 48px;
      line-height: 1.5;
    }
    .hero {
      position: sticky;
      top: 0;
      background: var(--vscode-editor-background);
      padding: 24px 0 12px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
      margin-bottom: 8px;
    }
    .hero h1 { margin: 0; font-size: 2em; }
    .hero .subtitle { margin: 4px 0 0; opacity: 0.75; font-size: 0.95em; }
    .entry { margin: 20px 0; }
    .entry h2 {
      font-size: 1.25em;
      margin: 0 0 8px;
      color: var(--vscode-textLink-foreground);
    }
    .entry h2 .date { font-size: 0.7em; font-weight: normal; opacity: 0.6; margin-left: 8px; }
    ul { margin: 0; padding-left: 22px; }
    li { margin: 4px 0; }
    code {
      font-family: var(--vscode-editor-font-family, monospace);
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.18));
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 0.9em;
    }
    a { color: var(--vscode-textLink-foreground); }
    a:hover { color: var(--vscode-textLink-activeForeground); }
    .footer { margin-top: 32px; font-size: 0.9em; opacity: 0.8; }
    .empty { opacity: 0.7; }
  </style>
</head>
<body>
  <div class="hero">
    <h1>✨ What's New!</h1>
    <p class="subtitle">${subtitle}</p>
  </div>
  ${changelogToHtml(entries)}
  <p class="footer">
    Read the full history in the
    <a href="${REPO_CHANGELOG_URL}">changelog on GitHub</a>.
  </p>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
