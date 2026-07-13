# Filter Lines

A minimal VS Code extension that filters the lines of the active editor by
one or more keywords and shows the result in a new, read-only virtual
document.

## Usage

1. Open a text/log file in the editor.
2. Run **Filter Lines: Filter Logs by Keywords** from the Command Palette
   (`filter.logs`).
3. Enter search terms separated by commas (e.g. `ERROR, WARN, timeout`).
4. Choose whether lines must match **any** (`OR`) or **all** (`AND`) terms.
5. A new read-only tab opens with only the matching lines.

## Development

```bash
npm install
npm run compile   # or: npm run watch
```

Press `F5` in VS Code to launch an Extension Development Host with the
extension loaded, then run the `filter.logs` command there.

## Adjusting the filter logic

All matching logic lives in the `filterLines` function in
`src/extension.ts`. It currently does a case-insensitive substring match;
adjust it there if you need regex support, case sensitivity, whole-word
matching, etc.
