import * as vscode from 'vscode';

/**
 * URI scheme used for the virtual, read-only result documents.
 * Documents served by a registered TextDocumentContentProvider are
 * read-only by design, so no extra logic is needed to prevent editing.
 */
const SCHEME = 'filter-lines';

/** Debounce delay for live filtering while the user is typing. */
const TYPE_DEBOUNCE_MS = 150;

/**
 * In-memory store for the generated content of each virtual document,
 * keyed by the URI's string representation. Filtering happens once per
 * keystroke (debounced); `provideTextDocumentContent` is just a lookup,
 * so re-focusing or splitting the result tab never re-runs the filter.
 */
const resultStore = new Map<string, string>();

/**
 * Provides the content for our virtual `filter-lines:` documents and
 * lets us push live updates into an already-open result tab via the
 * `onDidChange` event (VS Code then re-reads only that virtual document —
 * the source editor buffer is never touched or re-rendered).
 */
class FilterResultContentProvider implements vscode.TextDocumentContentProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  update(uri: vscode.Uri, content: string): void {
    resultStore.set(uri.toString(), content);
    this.onDidChangeEmitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return resultStore.get(uri.toString()) ?? '';
  }
}

/**
 * ---------------------------------------------------------------------
 * FILTER OPTIONS & LOGIC
 * ---------------------------------------------------------------------
 * `FilterOptions` + `filterLines` are the two things to edit if you want
 * to change how lines are matched (whole-word matching, trimming, etc.).
 */
interface FilterOptions {
  /** true = a line must contain ALL terms (AND); false = at least one (OR). */
  matchAll: boolean;
  /** true = exact-case matching; false = case-insensitive (default). */
  caseSensitive: boolean;
  /** true = treat each term as a JavaScript regular expression. */
  useRegex: boolean;
  /** true = KEEP lines that do NOT match (exclude mode, like `grep -v`). */
  invert: boolean;
}

/**
 * Filters `lines` according to `terms` and `opts`.
 *
 * @param lines      All lines of the source document.
 * @param lowerLines Pre-lowercased copy of `lines`. Computed once per
 *                   command invocation and reused across keystrokes so we
 *                   don't call toLowerCase() on every line on every
 *                   keypress (this is the main cost on large log files).
 * @throws SyntaxError if `opts.useRegex` is set and a term is not a
 *                     valid regular expression (caller shows the error).
 */
function filterLines(
  lines: string[],
  lowerLines: string[],
  terms: string[],
  opts: FilterOptions
): string[] {
  if (opts.useRegex) {
    // One RegExp per term, compiled once per filter run — not per line.
    const regexes = terms.map((t) => new RegExp(t, opts.caseSensitive ? '' : 'i'));
    return lines.filter((line) => {
      const matched = opts.matchAll
        ? regexes.every((r) => r.test(line))
        : regexes.some((r) => r.test(line));
      return matched !== opts.invert;
    });
  }

  // Plain substring mode.
  const needles = opts.caseSensitive ? terms : terms.map((t) => t.toLowerCase());
  const haystacks = opts.caseSensitive ? lines : lowerLines;
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const hay = haystacks[i];
    const matched = opts.matchAll
      ? needles.every((n) => hay.includes(n))
      : needles.some((n) => hay.includes(n));
    if (matched !== opts.invert) {
      result.push(lines[i]);
    }
  }
  return result;
}

/** Splits the raw QuickPick input into non-empty, trimmed search terms. */
function parseTerms(input: string): string[] {
  return input
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * ---------------------------------------------------------------------
 * TOGGLE BUTTONS
 * ---------------------------------------------------------------------
 * The four filter options are exposed as buttons in the QuickPick title
 * bar, so there is no second modal dialog. Each button carries an `id`
 * so the trigger handler knows which option to flip.
 */
type ToggleId = keyof FilterOptions;

interface ToggleButton extends vscode.QuickInputButton {
  id: ToggleId;
}

function makeButtons(opts: FilterOptions): ToggleButton[] {
  return [
    {
      id: 'matchAll',
      iconPath: new vscode.ThemeIcon(opts.matchAll ? 'combine' : 'list-flat'),
      tooltip: opts.matchAll
        ? 'Logic: AND — line must contain all terms (click for OR)'
        : 'Logic: OR — line must contain at least one term (click for AND)',
    },
    {
      id: 'caseSensitive',
      iconPath: new vscode.ThemeIcon('case-sensitive'),
      tooltip: `Case sensitive: ${opts.caseSensitive ? 'ON' : 'OFF'} (click to toggle)`,
    },
    {
      id: 'useRegex',
      iconPath: new vscode.ThemeIcon('regex'),
      tooltip: `Regex mode: ${opts.useRegex ? 'ON' : 'OFF'} (click to toggle)`,
    },
    {
      id: 'invert',
      iconPath: new vscode.ThemeIcon('exclude'),
      tooltip: `Invert (exclude matching lines): ${opts.invert ? 'ON' : 'OFF'} (click to toggle)`,
    },
  ];
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new FilterResultContentProvider();

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    vscode.commands.registerCommand('filter.logs', () => runFilterLogsCommand(provider)),
    // Free the cached result once its tab/document is actually closed,
    // so long sessions with many filter runs don't accumulate memory.
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === SCHEME) {
        resultStore.delete(doc.uri.toString());
      }
    })
  );
}

export function deactivate(): void {
  // Subscriptions registered via context.subscriptions are disposed
  // automatically by VS Code.
}

async function runFilterLogsCommand(provider: FilterResultContentProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme === SCHEME) {
    vscode.window.showWarningMessage('Filter Lines: Open a text file first.');
    return;
  }

  // Snapshot the source ONCE per invocation. Every keystroke afterwards
  // only re-runs the linear filter pass over these arrays — the editor
  // buffer is never re-read or re-rendered while typing.
  const sourceDoc = editor.document;
  const lines = sourceDoc.getText().split(/\r\n|\r|\n/);
  const lowerLines = lines.map((l) => l.toLowerCase());
  const sourceName = sourceDoc.fileName.split(/[\\/]/).pop() ?? 'document';
  const totalLines = lines.length;

  // Default options; flipped live via the title-bar toggle buttons.
  const opts: FilterOptions = {
    matchAll: false,
    caseSensitive: false,
    useRegex: false,
    invert: false,
  };

  // One stable URI per invocation: the result tab opens once and is then
  // updated in place through the content provider's onDidChange event.
  const uri = vscode.Uri.parse(`${SCHEME}:/${sourceName}.filtered-${Date.now()}.log`);
  provider.update(uri, '-- Type comma-separated terms in the filter box above --');

  const quickPick = vscode.window.createQuickPick();
  quickPick.placeholder = 'Search terms, comma-separated (e.g. ERROR, WARN, timeout)';
  quickPick.title = `Filter "${sourceName}" — type to filter`;
  quickPick.buttons = makeButtons(opts);
  // The result tab opening beside us steals focus for a moment;
  // without this the QuickPick would close itself immediately.
  quickPick.ignoreFocusOut = true;
  // We use the QuickPick purely as a live input box — no list entries.
  quickPick.items = [];

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const applyFilter = (): void => {
    const terms = parseTerms(quickPick.value);
    if (terms.length === 0) {
      quickPick.title = `Filter "${sourceName}" — type to filter`;
      provider.update(uri, '-- Type comma-separated terms in the filter box above --');
      return;
    }

    let filtered: string[];
    try {
      filtered = filterLines(lines, lowerLines, terms, opts);
    } catch (err) {
      // Invalid regex while typing is expected (e.g. a lone "(").
      // Show it in the title and keep the previous result on screen.
      quickPick.title = `Invalid regex: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }

    const logicLabel = opts.matchAll ? 'AND' : 'OR';
    const flags = [
      opts.caseSensitive ? 'case' : null,
      opts.useRegex ? 'regex' : null,
      opts.invert ? 'inverted' : null,
    ]
      .filter(Boolean)
      .join(', ');
    quickPick.title =
      `Filter "${sourceName}" — ${filtered.length}/${totalLines} lines` +
      ` (${logicLabel}${flags ? ', ' + flags : ''})`;

    provider.update(
      uri,
      filtered.length > 0
        ? filtered.join('\n')
        : `-- No lines matched: ${terms.join(', ')} (${logicLabel}) --`
    );
  };

  quickPick.onDidChangeValue(() => {
    // Debounce so huge files aren't re-filtered on every single keypress.
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(applyFilter, TYPE_DEBOUNCE_MS);
  });

  quickPick.onDidTriggerButton((button) => {
    const id = (button as ToggleButton).id;
    opts[id] = !opts[id];
    quickPick.buttons = makeButtons(opts);
    // Option changes should feel instant — no debounce here.
    applyFilter();
  });

  // Enter confirms: keep the result tab as-is and close the input.
  quickPick.onDidAccept(() => quickPick.hide());

  quickPick.onDidHide(() => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    quickPick.dispose();
  });

  // Open the (still empty) result tab beside the source first, then show
  // the input on top of it so the user sees matches appear while typing.
  const resultDoc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(resultDoc, {
    preview: false,
    preserveFocus: true,
    viewColumn: vscode.ViewColumn.Beside,
  });
  quickPick.show();
}
