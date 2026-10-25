# strange_ringtone

A small, self-hostable web tool that turns an audio clip into an iPhone
ringtone. You trim, fade and level a clip in the phone's browser, then hand it to
iOS 26's **Share → Use as Ringtone**. No GarageBand, no computer and no cable.

> **Status: pre-release.** There is nothing to deploy yet. v0.1.0 is being built
> in the open, and the design record is [docs/PLAN.md](docs/PLAN.md).

## How it will work

1. Open the app on an iPhone running iOS 26 or later and pick an audio file. With
   the optional fetcher, you can instead share a YouTube link to it from the
   YouTube app.
2. Drag the selection (up to 30 s), set the fade-in and fade-out, and choose how
   loud the tone should be. Everything previews instantly in the browser.
3. Tap **Get on this iPhone**, then **Use as Ringtone**. If the share sheet doesn't
   offer it, download the file and share it from Safari's downloads list.

iOS names the tone after the file, so the name you type is the name Settings
shows.

## Design

- **The browser does the decoding.** It sends the server only the trimmed
  selection, as plain PCM WAV.
- **The server is small and strict.** It checks the WAV by content and encodes
  it with a minimal ffmpeg build: WAV in, AAC/MP4 out, with no network protocols
  compiled in.
- **It keeps no state.** Results live in a tmpfs for a few minutes and then
  disappear.
- **The core image never makes an outbound connection.**
- **YouTube fetching is a separate, opt-in image.** It is the only part with
  internet access, and it accepts nothing but an 11-character video ID.

## Repository layout

| Path | What |
| --- | --- |
| `docs/PLAN.md` | Research, decisions and the v0.1.0 plan |
| `tools/spike/phase0.py` | Generates the test tones that established the share sheet's rules |
| `scripts/` | Stdlib checks that CI runs on pull requests |
| `tests/` | Stdlib `unittest` tests |
| `.github/` | CI workflows, Dependabot, and hashed lockfiles for the CI tools |

## Development

The code targets Python 3.12 and uses the standard library only. Run the tests:

```bash
python -I -m unittest discover -s tests
```

Lint with the same ruff that CI uses, installed from its hashed lockfile:

```bash
python -m pip install --require-hashes --no-deps --only-binary :all: -r .github/lint/requirements.txt
```

```bash
ruff check .
```

Regenerate the spike tones. This needs a local ffmpeg with the `aac` and
`libmp3lame` encoders and the `ebur128` and `alimiter` filters:

```bash
python -I tools/spike/phase0.py
```

**Run locally.** Start the core server on loopback, then open
<http://127.0.0.1:8080/>:

```bash
PUBLIC_ORIGIN=http://127.0.0.1:8080 python -I core --bind 127.0.0.1
```

The other settings in [.env.example](.env.example) are read from the
environment the same way, and an invalid value stops the server at startup.
Without `--bind` the server listens on `0.0.0.0:8080`, which is meant for the
container; don't expose it on your LAN. The command passes the `core`
directory rather than `-m strange_ringtone`: `-I` leaves the current directory
off `sys.path`, so `-m` finds the package only where it is installed, while a
directory that Python runs is always on `sys.path`.

**Pull requests:** branch from `main` as `feat/…` or `fix/…`. PRs are
squash-merged, so their titles must be conventional-commit subjects (`feat:`,
`fix:`, `docs:`, `ci:`, `chore:`, with `!` for a breaking change). release-please
builds the changelog from them.

## Deployment contract

Not defined yet. v0.1.0 will define it here: the image, UID/GID, port, writable
paths, environment variables and limits. The draft is in
[docs/PLAN.md](docs/PLAN.md), section 5.7. After the first release, CI refuses any
change to this section unless the PR is marked as breaking.

## Security

See [SECURITY.md](SECURITY.md).

## License

[AGPL-3.0-or-later](LICENSE). If you run a modified version for other people,
section 13 requires you to offer them its source. The app's **Source** link
exists for that.
