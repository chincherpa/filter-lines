# Filter Lines

A VS Code extension that live-filters the lines of the active editor by
one or more keywords and shows the result in a read-only virtual document
that updates as you type.

## Usage

1. Open a text/log file in the editor.
2. Run **Filter Lines: Filter Logs by Keywords** from the Command Palette
   (`filter.logs`). A read-only result tab opens beside the source file.
3. Type search terms separated by commas (e.g. `ERROR, WARN, timeout`) —
   the result tab updates live while you type (debounced), and the input
   title shows the match count.
4. Use the toggle buttons in the input's title bar:
   - **AND/OR** — lines must contain all terms vs. at least one
   - **Aa** — case-sensitive matching
   - **.\*** — treat each term as a regular expression
   - **exclude** — invert: keep lines that do NOT match (like `grep -v`)
5. Press `Enter` to keep the current result and close the input, or
   `Esc` to close it (the result tab stays open either way).

## Development

```bash
npm install
npm run compile   # or: npm run watch
```

Press `F5` in VS Code to launch an Extension Development Host with the
extension loaded, then run the `filter.logs` command there.

## Adjusting the filter logic

All matching logic lives in `FilterOptions` and the `filterLines`
function in `src/extension.ts` — adjust there if you need whole-word
matching, trimming, or other match rules. Case sensitivity, regex mode,
AND/OR logic, and inversion are already built in as toggles.
