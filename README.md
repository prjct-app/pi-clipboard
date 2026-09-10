# pi-clipboard

[![pi-clipboard — extension for PI Agent](https://raw.githubusercontent.com/prjct-app/pi-clipboard/main/docs/cover.png)](https://pi.dev)

Preview pasted images in PI Agent before sending them, with inline thumbnails and a compact attachment gallery.

`@prjct.app/pi-clipboard` · Clipboard image previews; one extension.

## Install

Requires Pi installed separately and Node.js **22.19 or later**. Compatibility is tested with **Pi 0.85.1**; newer versions are not yet verified. This is an independent community package.

Install with Pi's package manager:

```sh
pi install npm:@prjct.app/pi-clipboard
```

For project-only installation, add `-l`: `pi install -l npm:@prjct.app/pi-clipboard`. Restart Pi after installation. Do not install the same extension from both GitHub and npm: Pi treats those as different package identities.

## Usage

1. Start an interactive Pi session after installing the package.
2. Paste an image using Pi's native clipboard flow.
3. Inspect the preview above the editor, then submit your message normally.

Previews appear automatically; there is no slash command to enable them. Removing an attachment path from the editor removes its preview. Multiple images form a gallery.

Only Pi-created temporary clipboard attachments are eligible. Arbitrary image paths do not produce previews. Supported filenames end in PNG, JPEG, WebP, or GIF; individual files over 50 MiB and symbolic links are rejected. Inline thumbnails depend on Pi's terminal image capabilities; other terminals show text cards. The extension itself makes no network requests. Submitting an image still follows Pi's normal model-provider attachment flow.


## Manage the package

For an npm installation:

```sh
pi list
pi update npm:@prjct.app/pi-clipboard
pi remove npm:@prjct.app/pi-clipboard
```

Use `pi config` to enable or disable individual resources. Use `pi config -l` for project settings and add `-l` to removal when you installed locally.

To pin version 0.1.3, use `pi install npm:@prjct.app/pi-clipboard@0.1.3`. Pi skips pinned npm versions during package updates. For a Git installation, update or remove using the same `git:github.com/prjct-app/pi-clipboard` source instead of the npm source.

When switching from GitHub to npm, remove the Git installation first, then install the npm package and restart Pi.

## Troubleshooting

If no preview appears, confirm you are in interactive TUI mode and pasted through Pi. Text cards are the expected fallback when inline images are unavailable.

## Package and API documentation

Uses `session_start`, `session_shutdown`, `ctx.ui.getEditorText()`, `ctx.ui.setWidget()`, and Pi TUI image components. It retains the native editor and attachment submission flow.

See [Package structure and compatibility](docs/package.md) for the manifest, dependency policy, shipped resources, and official references. This package follows the [official Pi package guide](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/packages.md) and [extension API guide](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/extensions.md) for the tested version.

## Development

From a repository checkout:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run check:package
```

Pi loads the TypeScript entry point directly; no build step is required. To try this checkout for one run, use `pi -e .`. Tests use isolated temporary state and do not call model APIs. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution rules and [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

[MIT](LICENSE).
