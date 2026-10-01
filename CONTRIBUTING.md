# Contributing to Tokenmeter

Thanks for helping. Bug reports, new tools, fixes and UI polish are all welcome.

## Reporting bugs and ideas

Open an [issue](https://github.com/mugeshk97/tokenmeter/issues) with your OS, the Tokenmeter version (the release you installed), what you expected and what happened. For a card showing wrong numbers, say which tool and plan you use. **Never paste API keys or tokens.**

Security problems: report them privately through [GitHub security advisories](https://github.com/mugeshk97/tokenmeter/security/advisories/new), not a public issue.

## Development setup

You need Node.js 22 (what CI uses) and git.

```bash
git clone https://github.com/mugeshk97/tokenmeter.git
cd tokenmeter
npm install
npm run demo       # the UI with sample data
npm start          # the real app, reading your own tools
npm test           # must pass before a pull request
```

If `npm start` says Electron failed to install, your npm may have skipped install scripts; run `node node_modules/electron/install.js` once.

## How the code is organized

- **Main process** (`src/main.js`): the window, tray, IPC, polling and settings. `src/updater.js` handles auto-update, `src/config.js` settings and encrypted secrets, and `src/poller.js` refresh scheduling.
- **Providers** (`src/providers/`): one module per tool. Each returns a plain card object; they never touch the UI.
- **Renderer** (`src/renderer/`): plain HTML, CSS and JavaScript, with no framework. It runs with a strict Content Security Policy and no Node.js. Inline `style="…"` attributes are blocked by the CSP, so use classes (or `element.style.setProperty` from JavaScript).
- **Tests** (`test/`): `node:test`, with mocked HTTP responses and fake log folders. They never touch the network.

## Adding a tool

1. **Write the provider** in `src/providers/<tool>.js`, exporting an async function that returns a card:

   ```js
   {
     headline: { value: '29%', label: 'left this week', short: 'left this week' }, // short: Compact label
     foot: 'resets in 2d 4h',                                  // one-line footnote in Compact
     meters: [{ label: 'Weekly limit', pct: 71, detail: '29% left · 2d 4h' }], // pct = share USED, 0-100
     stats: [{ label: 'Tokens today', value: '1.2M' }],
     spark: { label: 'tokens / hour, today', points: [/* numbers */] },    // or null
     note: 'Shown in Detailed',                                // or null
   }
   ```

   Lead with what's **left**. The widget turns a meter red when `pct` reaches 80, and sorts cards by their tightest meter. Throw an `Error` with a friendly message on failure; the card then shows it with a Retry or Fix key button. The helpers in `src/providers/util.js` cover HTTP with timeouts, number formatting and the budget headline. Local cards are re-read every minute, so wrap any network call in a local provider with `cachedJson` (a few minutes' TTL; it keeps the last good copy on errors).

   **Using a tool's own sign-in** (as the Claude Code and Codex cards do for plan limits): only read the token the tool saved, never refresh or write it back, and send it only to that tool's own provider. Fall back to the local numbers when the sign-in is missing, expired or rejected, and say why in `note`.
2. **Register it** in `src/providers/index.js` with an `id`, `name`, `short` name, `kind` (`'local'` or `'remote'`), `console` (its usage page), `secrets`, `isConfigured` and `run`.
3. **Add it to the defaults** in `src/config.js` (`order` and `providers`).
4. **Add its Settings fields** in `PROVIDER_FIELDS` in `src/renderer/app.js`: help text, key and any folder or budget fields.
5. **Add a demo card** in `src/demo.js`, so `npm run demo` shows it.
6. **Test it** in `test/providers.test.js` with a mocked response (pass `fetchImpl`) or a fake log folder, including the error and fallback cases.
7. **Document it** in the Supported tools table in `README.md` and the tools list on the landing page (`site/index.html`). If it sends anything over the network, add that to the README's Privacy and security section too.

## Making UI changes

- Check both themes (`AIU_THEME=dark npm run demo`, then `light`) and all three card sizes.
- Keep it keyboard-usable: every control needs an accessible name, and nothing should rely on hover or color alone.
- Use the color tokens at the top of `src/renderer/styles.css` rather than raw colors.
- Include before and after screenshots in the pull request.

## Pull requests

1. Branch from `dev`.
2. Keep each pull request to one change, and match the style of the code around it.
3. Run `npm test`. CI runs it on Linux, Windows and macOS.
4. Describe what changed and why; link the issue if there is one.

## Icons

The app, tray and installer icons are all rendered from `assets/logo.svg` and `assets/tray.svg`. After editing those, run `npm run icons` to regenerate the PNGs, the Windows `.ico` and the macOS `.icns`.

## Releasing (maintainers)

```bash
npm version patch            # or minor / major: bumps package.json and tags vX.Y.Z
git push origin dev --follow-tags
```

The tag starts `.github/workflows/release.yml`, which:

1. builds the Linux `.deb`, Windows installer and macOS `.zip` (Apple Silicon and Intel) into a draft release;
2. checks every installer and update file (`latest*.yml`) is there, then publishes the release;
3. rebuilds the signed apt repository on GitHub Pages from the new `.deb`;
4. updates the Homebrew cask in [mugeshk97/homebrew-tap](https://github.com/mugeshk97/homebrew-tap) to the new macOS `.zip` files (needs the `HOMEBREW_TAP_TOKEN` secret: a fine-grained token with Contents read and write on that repo). The tap's own workflow then test-installs it on a Mac.

The release starts with auto-generated notes; replace them with a short, user-facing summary (what's new, install per OS, upgrade notes) using `gh release edit vX.Y.Z --notes-file notes.md`. See v1.0.2 for the format.

The apt repository is signed with the key in the `APT_GPG_PRIVATE_KEY` repository secret; its public half is `packaging/apt/tokenmeter-archive-keyring.asc`. If a release fails partway, nothing is published: delete the draft and the tag (`gh release delete vX.Y.Z --yes`, `git push origin :vX.Y.Z`, `git tag -d vX.Y.Z`), fix the problem and tag again.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
