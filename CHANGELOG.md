# Changelog

## Unreleased

- Render clipboard previews with Pi's native TUI `Image` components instead of a bundled PNG codec and rasterizer.
- Show Pi's native `[Image: ...]` fallback (with path and dimensions) on terminals without inline-image support.
- Feed Kitty placements PNG payloads converted through Pi's native `convertToPng`, so JPEG, WebP, and GIF pastes render on Kitty-protocol terminals such as Ghostty, Kitty, WezTerm, and Warp.
- Keep the security posture unchanged: only Pi temporary clipboard files are read, symbolic links and files over 50 MiB are rejected, and no network calls or external tools are required.

## 0.1.3

- Clarify the package description and add focused discovery keywords.
- Declare the cover image for the official Pi package gallery.

- Align repository, documentation, and cover URLs with the npm package name.

## 0.1.1

- Add a dedicated cover to the GitHub and npm README.
- Keep the existing extension behavior unchanged.

## 0.1.0

- Set the npm package identity to `@prjct.app/pi-clipboard`.
- Clarify installation, project scope, updates, removal, usage, and limitations.
- Document resource discovery and dependencies against the official Pi 0.85.1 guides.
- Include contribution and package documentation in the release file list.

Initial npm release. The documentation and naming changes preserve the existing extension runtime behavior.
