# pi-image-preview

Safe inline previews for images pasted into the [Pi coding agent](https://github.com/earendil-works/pi-mono).

`pi-image-preview` watches Pi's native editor for clipboard attachment paths and renders a compact gallery above it. The attachment path stays in Pi's editor, so submission continues through Pi's native image flow.

## Why this package

- Uses a Pi widget instead of replacing the native editor.
- Uses Pi's bundled TUI image support, including Kitty graphics where available.
- Falls back to textual image cards in unsupported terminals.
- Supports multiple images, horizontal galleries, and wrapping.
- Stops polling and removes its widget on session shutdown or extension reload.
- Reads only Pi clipboard files named `pi-clipboard-<uuid>.<image-extension>` directly inside the system temporary directory.
- Rejects symbolic links and files larger than 50 MiB, and never sends image data over the network.

## Install

The package is currently available from GitHub:

```sh
pi install git:github.com/prjct-app/pi-image-preview
```

Restart Pi after installation. To remove it:

```sh
pi remove git:github.com/prjct-app/pi-image-preview
```

The npm identity is reserved as `@prjct-app/pi-image-preview`; the unscoped `pi-image-preview` name belongs to a different community project. This repository has not been published to npm yet.

## Compatibility

Tested with Pi `0.85.1` and Node.js `22.19+`.

Image rendering follows Pi TUI capabilities. Terminals with Kitty graphics support receive real inline thumbnails; other terminals receive accessible textual cards. Pi's normal clipboard behavior and model attachment support still determine whether an image can be submitted.

## Design

The extension polls only the native editor text at a short interval. It reads a file once when a new eligible attachment path appears, composes previews into one PNG gallery, and renders that gallery through Pi's public `Image` component. It does not install a custom editor, intercept keyboard input, transform prompts, spawn subprocesses, or register process-level signal handlers.

## Development

```sh
npm install
npm run check
npm test
```

Tests use temporary image files and do not access the real clipboard, Pi configuration, network, or model APIs.

See [CONTRIBUTING.md](CONTRIBUTING.md) before making changes.

## License

[MIT](LICENSE)
