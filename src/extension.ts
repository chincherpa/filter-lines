import * as vscode from 'vscode';

/**
 * URI scheme used for the virtual, read-only result documents.
 * Documents served by a registered TextDocumentContentProvider are
 * read-only by design, so no extra logic is needed to prevent editing.
 */
const SCHEME = 'filter-lines';

/** Debounce delay for live filtering while the user is typing. */
const TYPE_DEBOUNCE_MS = 150;

/** Values the context-lines toggle button cycles through (grep -C style). */
const CONTEXT_CYCLE = [0, 1, 2, 3, 5];

/**
 * ---------------------------------------------------------------------
 * FILTER OPTIONS & LOGIC
 * ---------------------------------------------------------------------
 * `FilterOptions` + `filterLineIndices` are the two things to edit if
 * you want to change how lines are matched (whole-word matching,
 * trimming, etc.).
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
 * Everything we know about one result document. Kept per result URI so
 * that (a) `provideTextDocumentContent` is a cheap lookup, (b) Ctrl+Click
 * can map result lines back to source lines, (c) decorations know where
 * the matches are, and (d) the re-run command can repeat the exact query.
 */
interface ResultState {
  sourceUri: vscode.Uri;
  sourceName: string;
  terms: string[];
  opts: FilterOptions;
  contextLines: number;
  /** Rendered document text served by the content provider. */
  content: string;
  /** result-doc line index -> 0-based source line (undefined = header/separator). */
  lineMap: (number | undefined)[];
  /** Ranges of term occurrences in the result doc, for highlighting. */
  matchRanges: vscode.Range[];
}

/** State per result URI (string form). */
const resultStore = new Map<string, ResultState>();

/** Highlight style for matched terms in the result document. */
let matchDecoration: vscode.TextEditorDecorationType;

/**
 * Provides the content for our virtual `filter-lines:` documents and
 * lets us push live updates into an already-open result tab via the
 * `onDidChange` event (VS Code then re-reads only that virtual document —
 * the source editor buffer is never touched or re-rendered).
 */
class FilterResultContentProvider implements vscode.TextDocumentContentProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  update(uri: vscode.Uri, state: ResultState): void {
    resultStore.set(uri.toString(), state);
    this.onDidChangeEmitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return resultStore.get(uri.toString())?.content ?? '';
  }
}

/**
 * Ctrl+Click (or F12) on a result line jumps to the original line in the
 * source file, using the per-result `lineMap`.
 */
class FilterResultDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Definition | undefined {
    const state = resultStore.get(document.uri.toString());
    const sourceLine = state?.lineMap[position.line];
    if (state === undefined || sourceLine === undefined) {
      return undefined;
    }
    return new vscode.Location(state.sourceUri, new vscode.Position(sourceLine, 0));
  }
}

/**
 * Returns the 0-based indices of all source lines that survive the filter.
 *
 * @param lowerLines Pre-lowercased copy of `lines`, computed once per
 *                   invocation so case-insensitive filtering doesn't call
 *                   toLowerCase() per line per keystroke on large files.
 * @throws SyntaxError if `opts.useRegex` is set and a term is invalid
 *                     (the caller shows the error and keeps the old result).
 */
function filterLineIndices(
  lines: string[],
  lowerLines: string[],
  terms: string[],
  opts: FilterOptions
): number[] {
  const matched: number[] = [];

  if (opts.useRegex) {
    // One RegExp per term, compiled once per filter run — not per line.
    const regexes = terms.map((t) => new RegExp(t, opts.caseSensitive ? '' : 'i'));
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hit = opts.matchAll
        ? regexes.every((r) => r.test(line))
        : regexes.some((r) => r.test(line));
      if (hit !== opts.invert) {
        matched.push(i);
      }
    }
    return matched;
  }

  // Plain substring mode.
  const needles = opts.caseSensitive ? terms : terms.map((t) => t.toLowerCase());
  const haystacks = opts.caseSensitive ? lines : lowerLines;
  for (let i = 0; i < lines.length; i++) {
    const hay = haystacks[i];
    const hit = opts.matchAll
      ? needles.every((n) => hay.includes(n))
      : needles.some((n) => hay.includes(n));
    if (hit !== opts.invert) {
      matched.push(i);
    }
  }
  return matched;
}

/**
 * Builds a function that finds all [start, end) spans of term occurrences
 * inside a single line of text — used to highlight matches in the result.
 */
function buildHighlighter(
  terms: string[],
  opts: FilterOptions
): (text: string) => Array<[number, number]> {
  if (opts.useRegex) {
    const flags = (opts.caseSensitive ? '' : 'i') + 'g';
    const regexes = terms.map((t) => new RegExp(t, flags));
    return (text) => {
      const spans: Array<[number, number]> = [];
      for (const re of regexes) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          if (m[0].length === 0) {
            // Zero-length match (e.g. "a*") — step forward to avoid looping.
            re.lastIndex++;
            continue;
          }
          spans.push([m.index, m.index + m[0].length]);
        }
      }
      return spans;
    };
  }

  const needles = opts.caseSensitive ? terms : terms.map((t) => t.toLowerCase());
  return (text) => {
    const hay = opts.caseSensitive ? text : text.toLowerCase();
    const spans: Array<[number, number]> = [];
    for (const needle of needles) {
      let from = 0;
      let at: number;
      while ((at = hay.indexOf(needle, from)) !== -1) {
        spans.push([at, at + needle.length]);
        from = at + needle.length;
      }
    }
    return spans;
  };
}

/**
 * ---------------------------------------------------------------------
 * RENDERING
 * ---------------------------------------------------------------------
 * Turns the matched line indices into the final result document:
 *   - an informational header,
 *   - context blocks (grep -C style) separated by `--`,
 *   - each line prefixed with its ORIGINAL 1-based line number,
 * and simultaneously produces the line map (for go-to-source) and the
 * highlight ranges (for decorations), so the text is walked only once.
 */
function renderResult(
  lines: string[],
  matchedIndices: number[],
  state: Pick<ResultState, 'sourceName' | 'terms' | 'opts' | 'contextLines'>
): { content: string; lineMap: (number | undefined)[]; matchRanges: vscode.Range[] } {
  const { sourceName, terms, opts, contextLines } = state;

  const flags = [
    opts.caseSensitive ? 'case-sensitive' : null,
    opts.useRegex ? 'regex' : null,
    opts.invert ? 'inverted' : null,
  ]
    .filter(Boolean)
    .join(', ');

  const header = [
    `# ${sourceName} — filtered`,
    `# Terms: ${terms.join(', ')} | Logic: ${opts.matchAll ? 'AND' : 'OR'}` +
      (flags ? ` | ${flags}` : '') +
      (contextLines > 0 ? ` | Context: ±${contextLines}` : ''),
    `# ${matchedIndices.length} of ${lines.length} lines matched — ${new Date().toLocaleString()}`,
    `# Ctrl+Click a result line to jump to it in the source file`,
    '',
  ];

  const out: string[] = [...header];
  const lineMap: (number | undefined)[] = header.map(() => undefined);
  const matchRanges: vscode.Range[] = [];

  if (matchedIndices.length === 0) {
    out.push(`-- No lines matched --`);
    lineMap.push(undefined);
    return { content: out.join('\n'), lineMap, matchRanges };
  }

  // Expand each match by `contextLines` and merge overlapping/adjacent
  // ranges into contiguous blocks (matchedIndices is already sorted).
  const blocks: Array<[number, number]> = [];
  for (const idx of matchedIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(lines.length - 1, idx + contextLines);
    const last = blocks[blocks.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      blocks.push([start, end]);
    }
  }

  // Width of the widest printed line number, for right-aligned prefixes.
  const width = String(blocks[blocks.length - 1][1] + 1).length;
  const highlight = buildHighlighter(terms, opts);

  for (let b = 0; b < blocks.length; b++) {
    if (b > 0) {
      // grep-style separator between non-contiguous blocks.
      out.push('--');
      lineMap.push(undefined);
    }
    const [start, end] = blocks[b];
    for (let i = start; i <= end; i++) {
      const prefix = `${String(i + 1).padStart(width)}: `;
      const outLineIdx = out.length;
      out.push(prefix + lines[i]);
      lineMap.push(i);
      // Highlight term occurrences, shifted by the line-number prefix.
      for (const [s, e] of highlight(lines[i])) {
        matchRanges.push(
          new vscode.Range(outLineIdx, prefix.length + s, outLineIdx, prefix.length + e)
        );
      }
    }
  }

  return { content: out.join('\n'), lineMap, matchRanges };
}

/** Applies the match decorations to every visible editor showing `uri`. */
function applyDecorations(uri: vscode.Uri): void {
  const state = resultStore.get(uri.toString());
  if (!state) {
    return;
  }
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.toString() === uri.toString()) {
      editor.setDecorations(matchDecoration, state.matchRanges);
    }
  }
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
 * The filter options are exposed as buttons in the QuickPick title bar,
 * so there is no second modal dialog. Each button carries an `id` so the
 * trigger handler knows which option to flip.
 */
type ButtonId = keyof FilterOptions | 'contextLines';

interface ToggleButton extends vscode.QuickInputButton {
  id: ButtonId;
}

function makeButtons(opts: FilterOptions, contextLines: number): ToggleButton[] {
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
    {
      id: 'contextLines',
      iconPath: new vscode.ThemeIcon('unfold'),
      tooltip: `Context lines: ±${contextLines} (click to cycle ${CONTEXT_CYCLE.join('→')})`,
    },
  ];
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new FilterResultContentProvider();

  matchDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });

  context.subscriptions.push(
    matchDecoration,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    vscode.languages.registerDefinitionProvider({ scheme: SCHEME }, new FilterResultDefinitionProvider()),
    vscode.commands.registerCommand('filter.logs', () => runFilterLogsCommand(provider)),
    vscode.commands.registerCommand('filter.rerun', (uri?: vscode.Uri) => rerunFilter(provider, uri)),
    // Re-apply highlights whenever a result document's content is swapped
    // in by the provider, or a result editor becomes visible again.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme === SCHEME) {
        applyDecorations(e.document.uri);
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) {
        if (editor.document.uri.scheme === SCHEME) {
          applyDecorations(editor.document.uri);
        }
      }
    }),
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
  // buffer is never re-read or re-rendered while typing. (The refresh
  // button on the result tab re-reads the source on demand.)
  const sourceDoc = editor.document;
  const sourceUri = sourceDoc.uri;
  const lines = sourceDoc.getText().split(/\r\n|\r|\n/);
  const lowerLines = lines.map((l) => l.toLowerCase());
  const sourceName = sourceDoc.fileName.split(/[\\/]/).pop() ?? 'document';

  // Default options; flipped live via the title-bar toggle buttons.
  const opts: FilterOptions = {
    matchAll: false,
    caseSensitive: false,
    useRegex: false,
    invert: false,
  };
  let contextLines = 0;

  // One stable URI per invocation: the result tab opens once and is then
  // updated in place through the content provider's onDidChange event.
  const uri = vscode.Uri.parse(`${SCHEME}:/${sourceName}.filtered-${Date.now()}.log`);

  const hintState = (): ResultState => ({
    sourceUri,
    sourceName,
    terms: [],
    opts: { ...opts },
    contextLines,
    content: '-- Type comma-separated terms in the filter box above --',
    lineMap: [],
    matchRanges: [],
  });
  provider.update(uri, hintState());

  const quickPick = vscode.window.createQuickPick();
  quickPick.placeholder = 'Search terms, comma-separated (e.g. ERROR, WARN, timeout)';
  quickPick.title = `Filter "${sourceName}" — type to filter`;
  quickPick.buttons = makeButtons(opts, contextLines);
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
      provider.update(uri, hintState());
      return;
    }

    let state: ResultState;
    try {
      const matched = filterLineIndices(lines, lowerLines, terms, opts);
      const meta = { sourceName, terms, opts: { ...opts }, contextLines };
      const rendered = renderResult(lines, matched, meta);
      state = { sourceUri, ...meta, ...rendered };
      quickPick.title =
        `Filter "${sourceName}" — ${matched.length}/${lines.length} lines` +
        ` (${opts.matchAll ? 'AND' : 'OR'})`;
    } catch (err) {
      // Invalid regex while typing is expected (e.g. a lone "(").
      // Show it in the title and keep the previous result on screen.
      quickPick.title = `Invalid regex: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }

    provider.update(uri, state);
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
    if (id === 'contextLines') {
      const next = (CONTEXT_CYCLE.indexOf(contextLines) + 1) % CONTEXT_CYCLE.length;
      contextLines = CONTEXT_CYCLE[next];
    } else {
      opts[id] = !opts[id];
    }
    quickPick.buttons = makeButtons(opts, contextLines);
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

/**
 * Re-runs the stored query of a result tab against the CURRENT content
 * of its source file (log files grow!). Bound to the refresh button in
 * the result tab's editor title bar.
 */
async function rerunFilter(
  provider: FilterResultContentProvider,
  uri?: vscode.Uri
): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target || target.scheme !== SCHEME) {
    return;
  }
  const state = resultStore.get(target.toString());
  if (!state || state.terms.length === 0) {
    vscode.window.showInformationMessage('Filter Lines: Nothing to re-run for this tab.');
    return;
  }

  let sourceDoc: vscode.TextDocument;
  try {
    sourceDoc = await vscode.workspace.openTextDocument(state.sourceUri);
  } catch {
    vscode.window.showWarningMessage(
      `Filter Lines: Source is no longer available (${state.sourceUri.toString()}).`
    );
    return;
  }

  const lines = sourceDoc.getText().split(/\r\n|\r|\n/);
  const lowerLines = lines.map((l) => l.toLowerCase());
  const matched = filterLineIndices(lines, lowerLines, state.terms, state.opts);
  const rendered = renderResult(lines, matched, state);
  provider.update(target, { ...state, ...rendered });
}
