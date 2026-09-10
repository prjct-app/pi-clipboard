# Contributing

- Integration branch: `main`. Create a feature branch from `main`.
- Deliver changes through a pull request using `.github/pull_request_template.md`.
- Use English for code, documentation, tests, issues, and pull requests.
- Use strict TypeScript and Pi's public extension/TUI interfaces.
- Keep image data local and limit file access to Pi clipboard files in the system temporary directory.
- Keep tests offline and use temporary files rather than the real Pi configuration or clipboard.
- Run `npm run check` and `npm test` before review.
- Never push, open or merge a pull request, publish, or deploy without explicit authorization.

## Package documentation

Follow [docs/package.md](docs/package.md) and its versioned official references. Keep README examples consistent with registered commands, distinguish tested behavior from unverified compatibility, and verify `npm run check:package` before release.
