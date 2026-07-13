import * as vscode from 'vscode';

/**
 * URI scheme used for the virtual, read-only result documents.
 * VS Code automatically treats documents served by a registered
 * TextDocumentContentProvider as read-only (there is no writeback path),
 * so we don't need any extra logic to prevent editing.
 */
const SCHEME = 'filter-lines';

/**
 * In-memory store for the generated content of each virtual document.
 * Keyed by the URI's string representation.
 *
 * Why a Map instead of recomputing on every `provideTextDocumentContent`
 * call: VS Code may call the provider multiple times (e.g. when the tab
 * regains focus or is split). Recomputing the filter over a huge log file
 * on every such call would be wasteful. We filter exactly once per
 * "filter.logs" invocation and just hand back the cached string afterwards.
 */
const resultStore = new Map<string, string>();

/**
 * Provides the content for our virtual `filter-lines:` documents.
 * The heavy lifting (filtering) already happened before the URI was
 * created; this provider is intentionally just a cheap lookup.
 */
class FilterResultContentProvider implements vscode.TextDocumentContentProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return resultStore.get(uri.toString()) ?? '';
  }
}

/**
 * ---------------------------------------------------------------------
 * FILTER LOGIC
 * ---------------------------------------------------------------------
 * This is the function to edit if you want to change how lines are
 * matched (e.g. case-sensitivity, regex support, trimming, etc.).
 *
 * @param lines     All lines of the source document.
 * @param keywords  Non-empty, trimmed search terms.
 * @param matchAll  true  => a line must contain ALL keywords ("AND").
 *                  false => a line must contain AT LEAST ONE keyword ("OR").
 */
function filterLines(lines: string[], keywords: string[], matchAll: boolean): string[] {
  // Lower-cased once up front so we don't repeat the conversion for every
  // line/keyword combination further down (important for large files).
  const lowerKeywords = keywords.map((k) => k.toLowerCase());

  return lines.filter((line) => {
    const lowerLine = line.toLowerCase();
    return matchAll
      ? lowerKeywords.every((kw) => lowerLine.includes(kw))
      : lowerKeywords.some((kw) => lowerLine.includes(kw));
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new FilterResultContentProvider();

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    vscode.commands.registerCommand('filter.logs', () => runFilterLogsCommand())
  );
}

export function deactivate(): void {
  // Nothing to clean up: subscriptions registered via context.subscriptions
  // are disposed automatically by VS Code.
}

async function runFilterLogsCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Filter Lines: Open a text file first.');
    return;
  }

  const input = await vscode.window.showInputBox({
    prompt: 'Enter search terms, separated by commas',
    placeHolder: 'ERROR, WARN, timeout',
    ignoreFocusOut: true,
  });

  // User cancelled (Esc) -> input is undefined. Empty string is a valid,
  // deliberate "no input" case, so we bail out on both.
  if (!input) {
    return;
  }

  const keywords = input
    .split(',')
    .map((term) => term.trim())
    .filter((term) => term.length > 0);

  if (keywords.length === 0) {
    vscode.window.showWarningMessage('Filter Lines: No valid search terms entered.');
    return;
  }

  // Optional AND/OR selection dialog, as requested.
  const logicChoice = await vscode.window.showQuickPick(
    [
      { label: 'OR', description: 'Keep lines that contain at least one term', matchAll: false },
      { label: 'AND', description: 'Keep lines that contain all terms', matchAll: true },
    ],
    { placeHolder: 'Combine search terms with...' }
  );

  if (!logicChoice) {
    return;
  }

  // Read the whole document text once and split it into lines a single
  // time. For very large files this is the dominant cost; everything
  // after this is a single linear pass, so there is no repeated
  // re-parsing or re-rendering of the source buffer.
  const sourceText = editor.document.getText();
  const lines = sourceText.split(/\r\n|\r|\n/);

  const filtered = filterLines(lines, keywords, logicChoice.matchAll);

  const resultText =
    filtered.length > 0
      ? filtered.join('\n')
      : `-- No lines matched: ${keywords.join(', ')} (${logicChoice.label}) --`;

  // Use a unique URI per run (timestamp) so repeated invocations open
  // fresh tabs instead of colliding, and store its content for the
  // provider to serve.
  const sourceName = editor.document.fileName.split(/[\\/]/).pop() ?? 'document';
  const uri = vscode.Uri.parse(
    `${SCHEME}:/${sourceName}.filtered-${Date.now()}.log`
  );
  resultStore.set(uri.toString(), resultText);

  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
}
