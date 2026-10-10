# nickel.tools browser extension

Adds a toolbar button that downloads Twitter/X media (as-is, as a GIF, or
rendered into a tweet card) and, on a second tab, the video or audio on
any page as MP4 (with a resolution picker), or extracts audio as MP3, M4A, Opus,
OGG, FLAC, ALAC or WAV, tagged with title, artist and cover art. Works on any site [yt-dlp](https://github.com/yt-dlp/yt-dlp)
supports (well over a thousand), not just YouTube, though YouTube is the
only one this has actually been tested against; other sites are "should
work, tell me if it doesn't" rather than verified. Estimated file size is
shown for each option before you download. Windows only, for now --
supports Firefox, Chrome, Edge, and Brave.

## Installing (Windows)

1. Close whichever of Firefox, Chrome, Edge, and Brave you have installed,
   if open. The installer needs this for Firefox specifically (see below)
   and will prompt you to close it if you forget; closing the Chromium
   browsers first just avoids needing to restart them afterward.
2. Download `nickel-tools-setup.exe` from the
   [latest release](https://github.com/teamuhi/nickel-tools/releases/latest).
3. Run it. Windows will show a SmartScreen warning ("Windows protected your
   PC") because the installer isn't code-signed; click "More info", then
   "Run anyway". This is expected, not a sign of anything wrong; see
   "Why the SmartScreen warning" below.
4. Approve the admin prompt (UAC). Admin rights are needed because the
   installer writes to Program Files and to each detected browser's own
   configuration; see "What the installer actually does" below for exactly
   what it changes. One installer handles every browser you have -- it
   detects which of Firefox/Chrome/Edge/Brave are actually installed and
   only touches those.
5. On the finish page, leave "Launch Firefox now" checked (or open it
   yourself afterward) if you use Firefox. For Chrome/Edge/Brave, no launch
   step is needed -- the extension appears the next time you open the
   browser. Open a YouTube video and click the extension's toolbar icon (it
   may be tucked under the puzzle piece icon; click it, then optionally pin
   the extension).

That's it. No Python install, no separate ffmpeg download, no manual
browser configuration; the installer bundles everything the extension
needs.

Why Firefox has to be closed: it only reads its extension configuration at
startup, so installing (or upgrading) while it's already running would
leave the extension not actually appear until some later restart you might
not think to make. For Chrome/Edge/Brave, closing first (or just restarting
after) is the safest bet too, until/unless you confirm on your own setup
that a running instance picks up the new policy on its own.

### Why the SmartScreen warning

The installer and the bundled program it installs (`host.exe`) aren't
signed with a code-signing certificate (those cost money on an ongoing
basis; this is a personal, free project). Unsigned Windows executables
routinely trigger SmartScreen and occasionally third-party antivirus,
regardless of what they actually do; it's a reputation heuristic, not a
detection of anything specific in this code. If you want to verify the
installer yourself before running it, the full source for everything it
contains is this repository; see "Building from source" below.

### What the installer actually does

Everything happens under a single admin prompt, for every browser it finds
installed:

- Copies the bundled program (a native Python runtime plus yt-dlp plus
  ffmpeg, packaged together so nothing separate needs installing) to
  `Program Files\nickel-tools\`. The same program serves every
  browser -- only how each browser is told to find it differs.
- Registers that program as a native messaging host for each browser it
  detects, at `HKLM\SOFTWARE\Mozilla\NativeMessagingHosts\...` for Firefox,
  and the equivalent `...\Google\Chrome\...`, `...\Microsoft\Edge\...`, and
  `...\BraveSoftware\Brave-Browser\...` keys for the others. This is what
  lets each browser launch it on demand instead of you having to start
  anything by hand.
- **Firefox**: installs the extension via Firefox's enterprise policy
  mechanism (a `distribution\policies.json` file next to `firefox.exe`).
  The extension is signed by Mozilla (through their unlisted/
  self-distribution channel, not a public Add-ons store listing), since
  regular release Firefox refuses to install an unsigned extension even via
  this mechanism; see "Why isn't the extension in an official store" below.
  If Firefox already has a `distribution\policies.json` (uncommon, usually
  only on managed/enterprise machines), the installer leaves it alone
  rather than risk overwriting it, and shows you the few lines to add by
  hand instead.
- **Chrome/Edge/Brave**: installs the extension via each browser's own
  `ExtensionInstallForcelist` enterprise policy, pointed at a small
  self-hosted update manifest (published alongside each GitHub release)
  rather than a store listing; see "Why isn't the extension in an official
  store" below. If that policy key already has unrelated entries from other
  software, the installer only ever adds its own entry alongside them, and
  removes only that one entry on uninstall.

Uninstalling (via Windows Settings, like any other program) reverses all of
the above, for whichever browsers were touched at install time.

### Why isn't the extension in an official store

**Firefox**: it *is* signed by Mozilla, just not publicly listed. Getting an
unlisted, self-distributed signed copy is a quick one-time setup (a free
Mozilla add-on developer account and API credentials) repeated for every
release; a full public listing adds a review/discovery process on top of
that, which isn't needed for a tool distributed via its own GitHub
releases. The enterprise policy install above is a real Firefox feature for
installing a signed-but-unlisted extension outside the store, not a
workaround; what it cannot do is skip signing entirely -- regular release
Firefox enforces that regardless of installation method.

**Chrome/Edge/Brave**: unlike Firefox, Chromium has no unlisted-but-signed
middle ground -- an extension is either in the Chrome Web Store (with its
own review process and a one-time developer fee) or self-hosted via
enterprise policy, which is what this installer does instead. The
extension is still cryptographically signed (with a private key held only
by the project maintainer), just verified via the self-hosted update
manifest rather than a store's signature.

## Using it

Open a page with video or audio, click the toolbar icon and pick **Video**
(MP4, with resolution) or **Audio**, each showing an estimated file size, and
click Download. Not every site has both: an audio-only page (a podcast, a
SoundCloud track) won't have any video resolutions, for instance.

**Audio** has its own music-style layout: a "now playing" card (cover, title,
artist, album, year), a grid of formats (MP3, M4A, Opus, OGG, FLAC, ALAC, WAV;
formats the bundled ffmpeg can't encode are hidden) and a bitrate picker for
the lossy ones. Title, artist, album, date, genre, track number, the video's
link and the thumbnail as cover art are filled in **automatically** (an
"Artist - Title" video title is split, and "(Official Video)" style noise is
dropped). Turn on **Edit metadata before downloading** to change any field or
replace/remove the cover; **Square cover** crops 16:9 thumbnails to a square,
and **Embed tags & cover art** switches tagging off.

The filename box is pre-filled with the video's own title as gray
placeholder text; type over it to save under a different name.

Progress shows in the popup. If you close it, the toolbar icon keeps showing
the export: a badge with the percentage (the number of exports when several
run, then a check or `!`), with the title in the icon's tooltip. You also get
a desktop notification when it starts and when it finishes or fails, since a
background script tracks the job independently. Click a finished-download
notification to open its folder in Explorer with the file selected.

By default the finished file lands in `Downloads
ickel-tools\` in
your user folder. Click the gear icon in the popup to set a different
default location -- click **Browse...** to pick a folder instead of typing a
path. This opens the normal Windows folder dialog (shown by the native host,
since a web page can't see the filesystem; use its **Make New Folder** button
to create one). The popup may close while the dialog has focus; the
background script finishes the job. The YouTube,
Twitter and Web tabs each have their own location; until you set one for
Twitter or Web it simply uses the YouTube one. To save just one download
somewhere else without changing any default, click the small folder icon
next to the Download button instead. Requires native host 0.8.0 or newer
(reinstall nickel.tools to update it); with an older host you can still type
a path into the browser's path box and confirm it.

### Settings

The gear icon opens the settings:

- **Save locations** per tab, each with Browse and Open buttons.
- **YouTube**: default video format (MP4, MKV or WebM). The same choice is on
  the YouTube tab as **Format**; WebM only offers VP9/AV1 and falls back to
  MP4 when the video has neither.
- **Notifications & badge**: progress on the toolbar icon, notify on start,
  finish and failure, and show the finished file in its folder.
- **Appearance & startup**: theme (System, Light or Dark), which tab opens
  first, and whether your last-used options are remembered.
- **X account**: use your x.com login for sensitive or protected tweets.
- **History**: the last downloads (with Show), and a clear button.
- **Maintenance**: extension, host and yt-dlp versions, and a reset button.

If a file with the resulting name already exists (re-downloading the same
video, or two videos ending up with the same name), the saved file gets
" (2)", " (3)", and so on appended, the same way a browser's own download
manager avoids overwriting.

Click the sun/moon icon to switch between light and dark mode; your choice
is remembered.

### The Twitter tab

The popup has two tabs, **YouTube** (everything above) and **Twitter**. On a
tweet link (`x.com/<user>/status/<id>`) it opens on the Twitter tab by
itself; you can switch tabs by hand at any time. A tweet with several media
items shows a thumbnail strip to pick which one to download.

- **Media only** saves the tweet's own file: the video as MP4 (pick a
  resolution; sizes X doesn't serve, such as 480p, are downscaled with ffmpeg
  and marked "scaled"), a photo at Original, Large, Medium or Small size, or a
  video/GIF **converted to a GIF**. For GIF you can set the frame rate, speed, resolution (width),
  and start/end points. A looping preview plays the chosen clip, and the
  **Set start** / **Set end** buttons take the preview's current time.
- **Tweet card** renders the tweet like a card: profile picture, name, @handle,
  and (each with its own checkbox) the tweet text, date/time and verified
  badge, in a **light or dark card theme** (independent of the popup's
  theme). A video or GIF tweet becomes an MP4 with the card around the
  video; a photo tweet becomes a PNG (up to four photos in a grid). The
  **Resolution** row renders the card at 1x, 2x (default) or 3x width (video
  cards stop at 2x).

A **quote post** (a tweet that embeds another tweet) is rendered the way X
shows it: the quoting tweet, then the quoted tweet in a bordered box with its
own avatar, name, date, text and media (a **Quote** checkbox turns that off).
The quoted post is also previewed in Media only mode, above the picture. The
quoted post's media also appears in the thumbnail strip, marked **QT**, and
can be downloaded or turned into a GIF like any other. Whichever video you
select plays in its own spot in the card, and the other post's media is shown
as a still. A plain *repost* has no link of its own (copying its link gives
the original post's URL), so a copied repost link produces the card of the
original post.

The card's **Translate** row picks a language (Off by default). The tweet text,
and the quoted post's text, are machine-translated into it (the source language
is detected automatically) and the card shows a "Translated from Russian"
line above each translated text, like X does. Text already in the chosen
language is left alone. Translation sends the tweet text to Google Translate's
public web endpoint through the native host, and needs an internet connection;
if it fails the card keeps the original text. Translation needs the updated
native host (reinstall after updating).

Sensitive or protected tweets need a logged-in account. With **Use my x.com
login** on (settings, on by default) the extension reads your browser's
x.com cookies and hands them to the local program for that one request,
nothing else; turn it off to never do that, at the cost of those tweets
failing with `E_AUTH_REQUIRED`.

When something fails, the popup and the notification show a short code and
a plain-language reason with a hint, e.g. `E_EXTRACTOR_BROKEN` (yt-dlp
probably outdated; the settings panel shows the bundled yt-dlp version and
age), `E_AUTH_REQUIRED`, `E_NOT_FOUND`, `E_NO_MEDIA`, `E_FORMAT` (different
format than expected), `E_RATE_LIMITED`, `E_NETWORK`, `E_FFMPEG_FAILED`.
The raw error is under "Details". The full list is in
`backend/errors.py`.

## Notes and limitations

- Any site yt-dlp supports is attempted; only YouTube has actually been
  tested, though. A page yt-dlp doesn't recognize shows an "Unsupported
  URL" style error rather than pretending to work.
- Playlist URLs aren't supported yet: a `watch?...&list=...`-style link
  downloads just that one video, and a bare playlist link is rejected with
  a message rather than silently doing the wrong thing. This applies on
  every site, not just YouTube.
- Chrome/Edge/Brave update the extension itself automatically (the same
  mechanism any enterprise-managed extension uses); the native host program
  behind it still needs the installer re-run for a new version, same as
  Firefox. Firefox has no auto-update for either part -- a new release
  means downloading and running the new installer, which upgrades
  everything in place.
- Respect copyright and each site's Terms of Service when downloading; this
  tool doesn't grant any rights to content you don't already have.

## Licensing note on the bundled ffmpeg

The installer bundles an ffmpeg build sourced from
[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds), configured for
LGPL rather than GPL licensing, so redistributing it doesn't carry GPL's
source-offer obligations. See `native-host/vendor/README.md` for the exact
version and build configuration used. yt-dlp itself is a separate pip
dependency (Unlicense, same as this repository), not vendored here; see the
top-level `LICENSE` file for this repository's own code.

## Uninstalling

Uninstall "nickel.tools" from Windows Settings > Apps, same as any
other program. This removes the installed files, every native messaging
registry entry it created, the Firefox policy entry, and the
`ExtensionInstallForcelist` entry for each Chromium browser it was
installed into (leaving any unrelated entries in that same policy list
untouched). You may also want to remove the extension from each browser's
own extensions page, though the uninstaller already prevents it from being
reinstalled automatically on next launch.

## Building from source

See `installer/README.md` for building the Windows installer from scratch
(PyInstaller bundling, sourcing ffmpeg, compiling with Inno Setup, packing
and signing the Chromium `.crx`), or `native-host/README.md` for a lighter
local development setup that skips packaging entirely (register the native
host against a plain Python script, reload the unpacked extension via
Firefox's `about:debugging` or Chrome/Edge/Brave's "Load unpacked").
`backend/server.py` is a separate, plain HTTP version of the same
download/convert logic (sharing `backend/core.py` with the native host),
kept around as a faster curl-testable loop while developing; it's not part
of the installed extension's runtime path.
