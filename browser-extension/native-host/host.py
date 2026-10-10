#!/usr/bin/env python
# coding: utf-8
"""Native messaging host for the nickel.tools Firefox extension.

Speaks Firefox's native messaging stdio protocol: each message is a 4-byte
little-endian length prefix followed by that many bytes of UTF-8 JSON, in
both directions. Firefox launches this process on
`browser.runtime.connectNative()` and kills it when the port disconnects, so
there's no server to start by hand and no auth token to pair.

Must never write anything but well-formed frames to stdout -- all logging
goes to a file instead.
"""

from __future__ import unicode_literals

import json
import logging
import os
import queue
import stat
import string
import struct
import subprocess
import sys
import threading
import time

# This process has no console (it's launched by Firefox with no console
# attached, same as pythonw.exe). Windows would otherwise pop a new,
# visible console window for every ffmpeg/ffprobe child process yt-dlp
# spawns -- which also steals focus and closes the extension popup. Force
# every subprocess this process creates to run without one.
if sys.platform == 'win32':
    _real_popen_init = subprocess.Popen.__init__

    def _no_window_popen_init(self, *args, **kwargs):
        kwargs['creationflags'] = kwargs.get('creationflags', 0) | subprocess.CREATE_NO_WINDOW
        _real_popen_init(self, *args, **kwargs)

    subprocess.Popen.__init__ = _no_window_popen_init

HOST_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.join(os.path.dirname(HOST_DIR), 'backend')
if not getattr(sys, 'frozen', False):
    sys.path.insert(0, BACKEND_DIR)

import core  # noqa: E402
import errors  # noqa: E402
import translate  # noqa: E402
import web  # noqa: E402

LOG_DIR = os.path.join(os.environ.get('LOCALAPPDATA', os.path.expanduser('~')), 'nickel-tools')
os.makedirs(LOG_DIR, exist_ok=True)
logging.basicConfig(
    filename=os.path.join(LOG_DIR, 'host.log'),
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
)
log = logging.getLogger('host')

# Reported to the popup's Maintenance section; also tells it which features
# (folder browser, container choice) this host build understands.
HOST_VERSION = '0.9.0'

# Chromium's MV3 service worker can be killed and restarted mid-download by
# the browser at any time, and reconnecting always spawns a NEW host.exe
# process rather than reattaching to whichever one is actually running the
# download -- there's no such API. So a restarted extension can only learn a
# job's status by asking (possibly a different) host process to read it back
# from disk. Firefox's persistent background page doesn't need this, but
# writing it unconditionally is harmless and gives both browsers the same
# small extra resilience (e.g. surviving the extension process itself
# restarting for unrelated reasons).
JOBS_DIR = os.path.join(LOG_DIR, 'jobs')
os.makedirs(JOBS_DIR, exist_ok=True)


def _job_path(request_id):
    return os.path.join(JOBS_DIR, '%s.json' % request_id)


def write_job_file(request_id, patch):
    path = _job_path(request_id)
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    data.update(patch)
    tmp_path = path + '.tmp'
    with open(tmp_path, 'w', encoding='utf-8') as f:
        json.dump(data, f)
    os.replace(tmp_path, path)


def read_job_file(request_id):
    with open(_job_path(request_id), 'r', encoding='utf-8') as f:
        return json.load(f)


def sweep_stale_jobs(max_age_seconds=6 * 3600):
    now = time.time()
    try:
        names = os.listdir(JOBS_DIR)
    except OSError:
        return
    for name in names:
        path = os.path.join(JOBS_DIR, name)
        try:
            if now - os.path.getmtime(path) > max_age_seconds:
                os.remove(path)
        except OSError:
            pass

# When bundled with PyInstaller, ffmpeg ships alongside the executable
# instead of relying on PATH. In a --onedir build, bundled binaries land in
# _internal/ next to the exe (sys._MEIPASS), not beside host.exe itself.
FFMPEG_LOCATION = getattr(sys, '_MEIPASS', None) if getattr(sys, 'frozen', False) else None

# Chrome/Edge/Brave don't necessarily close this process's stdout pipe when
# its service worker dies mid-download (observed directly: the browser can
# leave this process running with nobody reading its output at all). If a
# stdout write ever blocks because the OS pipe buffer fills up with nothing
# draining it, and that write happens on the download thread (send_message()
# is called from yt-dlp's own progress hook, i.e. from inside the download
# loop itself, not just from the main dispatch loop), the whole download
# freezes with it -- not just the progress notification. So actual writes
# happen on a single dedicated thread via a queue; send_message() itself
# only ever enqueues and returns immediately, no matter how stuck the
# consumer on the other end of stdout is.
SEND_QUEUE = queue.Queue()


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length or len(raw_length) < 4:
        return None  # stdin closed: Firefox disconnected the port
    length = struct.unpack('<I', raw_length)[0]
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode('utf-8'))


def _writer_loop():
    while True:
        message = SEND_QUEUE.get()
        try:
            data = json.dumps(message).encode('utf-8')
            sys.stdout.buffer.write(struct.pack('<I', len(data)))
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        except Exception:
            log.exception('failed to send message: %r', message)


def send_message(message):
    SEND_QUEUE.put(message)


def handle_ping(msg):
    send_message({'type': 'pong', 'requestId': msg.get('requestId')})


def handle_formats(msg):
    request_id = msg.get('requestId')
    try:
        info = core.fetch_formats(msg.get('url', ''), ffmpeg_location=FFMPEG_LOCATION)
        send_message(dict(info, type='formatsResult', requestId=request_id, ok=True))
    except Exception as e:
        send_message(dict(errors.classify_error(e, 'youtube'), type='formatsResult', requestId=request_id, ok=False))


def handle_tweet(msg):
    request_id = msg.get('requestId')
    try:
        info = core.get_tweet_info(msg.get('url', ''), msg.get('cookies'))
        send_message(dict(info, type='tweetResult', requestId=request_id, ok=True))
    except Exception as e:
        send_message(dict(errors.classify_error(e, 'twitter'), type='tweetResult', requestId=request_id, ok=False))


def handle_translate(msg):
    request_id = msg.get('requestId')
    try:
        results = translate.translate_all(msg.get('texts') or [], msg.get('target') or 'en')
        send_message({'type': 'translateResult', 'requestId': request_id, 'ok': True, 'results': results})
    except Exception as e:
        send_message(dict(errors.classify_error(e, 'twitter'), type='translateResult', requestId=request_id, ok=False))


def handle_download(msg):
    request_id = msg.get('requestId')
    url = msg.get('url', '')
    mode = msg.get('mode', '')
    quality = msg.get('quality')
    title = msg.get('title') or None
    download_dir = msg.get('downloadDir') or None  # one-off override; doesn't touch the saved default

    def on_progress(**kwargs):
        send_message(dict(kwargs, type='jobUpdate', requestId=request_id))
        write_job_file(request_id, kwargs)

    on_progress(status='starting', percent=0)

    if msg.get('source') == 'twitter':
        core.run_twitter_download(url, msg.get('options'), on_progress, ffmpeg_location=FFMPEG_LOCATION,
                                  download_dir=download_dir, title=title, cookies=msg.get('cookies'))
        return

    if msg.get('source') == 'web':
        web.run_web_download(msg.get('items'), msg.get('pageUrl') or url, on_progress, ffmpeg_location=FFMPEG_LOCATION,
                             download_dir=download_dir, title=title, subfolder=bool(msg.get('subfolder')),
                             convert=msg.get('convert'))
        return

    try:
        core.validate_download_request(url, mode, quality, msg.get('audio'))
    except ValueError as e:
        on_progress(status='error', **errors.classify_error(e, 'youtube'))
        return

    core.run_download(url, mode, quality, on_progress, ffmpeg_location=FFMPEG_LOCATION, download_dir=download_dir, title=title,
                      audio=msg.get('audio'), codec=msg.get('codec'), container=msg.get('container'))


def handle_reveal_file(msg):
    request_id = msg.get('requestId')
    path = msg.get('path', '')
    try:
        if not path or not os.path.exists(path):
            raise ValueError('File not found: %s' % path)
        # Opens the containing folder with this file selected/highlighted,
        # not just navigated to. Built as a single command-line string
        # (Windows-only concern: passing a list here lets Python's own
        # list2cmdline wrap the whole "/select,<path>" in one pair of
        # quotes when the path has spaces, which explorer.exe's argument
        # parser doesn't handle -- it needs /select, bare, immediately
        # followed by a separately-quoted path -- and silently falls back
        # to its default folder (Documents) instead of erroring.
        subprocess.Popen('explorer.exe /select,"%s"' % path)
        send_message({'type': 'revealFileResult', 'requestId': request_id, 'ok': True})
    except Exception as e:
        send_message({'type': 'revealFileResult', 'requestId': request_id, 'ok': False, 'error': str(e)})


def handle_get_job_status(msg):
    request_id = msg.get('requestId')
    job_id = msg.get('jobId') or request_id
    try:
        data = read_job_file(job_id)
        send_message(dict(data, type='jobStatusResult', requestId=request_id, ok=True))
    except (OSError, ValueError):
        send_message({'type': 'jobStatusResult', 'requestId': request_id, 'ok': False, 'error': 'not found'})


def handle_browse_folder(msg):
    # Browser extensions can't get a real filesystem path from a folder
    # picker (input[type=file] deliberately doesn't expose one, for
    # security). Since this process already has full filesystem access,
    # it shows a native OS folder dialog itself and hands the chosen path
    # back over the messaging channel instead. Blocks until the user
    # closes the dialog, so this always runs on its own thread.
    request_id = msg.get('requestId')
    try:
        import tkinter
        from tkinter import filedialog
        root = tkinter.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        root.lift()
        root.focus_force()
        initial_dir = core.get_download_dir(msg.get('source') or 'youtube')
        path = filedialog.askdirectory(
            initialdir=initial_dir if os.path.isdir(initial_dir) else None,
            title='Choose a download location',
        )
        root.destroy()
        send_message({'type': 'browseFolderResult', 'requestId': request_id, 'ok': True, 'path': path or None})
    except Exception as e:
        send_message({'type': 'browseFolderResult', 'requestId': request_id, 'ok': False, 'error': str(e)})


def _config_payload(request_id):
    return {
        'type': 'configResult',
        'requestId': request_id,
        'ok': True,
        'downloadDir': core.get_download_dir('youtube'),
        'twitterDownloadDir': core.get_download_dir('twitter'),
        'webDownloadDir': core.get_download_dir('web'),
        'hostVersion': HOST_VERSION,
        'ytdlp': errors.ytdlp_version_info(),
    }


def _is_hidden(path):
    try:
        attrs = os.stat(path).st_file_attributes  # Windows only
        return bool(attrs & (stat.FILE_ATTRIBUTE_HIDDEN | stat.FILE_ATTRIBUTE_SYSTEM))
    except (AttributeError, OSError):
        return os.path.basename(path).startswith('.')


def handle_list_dir(msg):
    """Lists the sub-folders of a directory for the popup's in-page folder
    picker (a native dialog would steal focus and close the popup)."""
    request_id = msg.get('requestId')
    try:
        path = msg.get('path') or core.get_download_dir(msg.get('source') or 'youtube')
        path = os.path.abspath(os.path.expanduser(path))
        # A not-yet-created save location: show its closest existing parent.
        while not os.path.isdir(path) and os.path.dirname(path) != path:
            path = os.path.dirname(path)
        dirs = []
        with os.scandir(path) as it:
            for entry in it:
                try:
                    if entry.is_dir() and not _is_hidden(entry.path):
                        dirs.append(entry.name)
                except OSError:
                    pass
        dirs.sort(key=str.lower)
        home = os.path.expanduser('~')
        places = [{'label': name, 'path': os.path.join(home, name)}
                  for name in ('Downloads', 'Desktop', 'Documents', 'Videos', 'Music', 'Pictures')
                  if os.path.isdir(os.path.join(home, name))]
        drives = ['%s:\\' % c for c in string.ascii_uppercase if os.path.exists('%s:\\' % c)] if sys.platform == 'win32' else ['/']
        parent = os.path.dirname(path)
        send_message({
            'type': 'listDirResult', 'requestId': request_id, 'ok': True,
            'path': path, 'parent': parent if parent != path else None,
            'dirs': dirs[:500], 'truncated': len(dirs) > 500, 'places': places, 'drives': drives,
        })
    except Exception as e:
        send_message({'type': 'listDirResult', 'requestId': request_id, 'ok': False, 'error': str(e)})


_BAD_DIR_NAME = set('\\/:*?"<>|')


def handle_make_dir(msg):
    request_id = msg.get('requestId')
    try:
        name = (msg.get('name') or '').strip()
        parent = msg.get('parent') or ''
        if not name or name in ('.', '..') or '..' in name or _BAD_DIR_NAME & set(name):
            raise ValueError('Folder names can\'t contain \\ / : * ? " < > |')
        if not os.path.isdir(parent):
            raise ValueError('Parent folder not found: %s' % parent)
        path = os.path.join(parent, name)
        os.makedirs(path, exist_ok=True)
        send_message({'type': 'makeDirResult', 'requestId': request_id, 'ok': True, 'path': path})
    except Exception as e:
        send_message({'type': 'makeDirResult', 'requestId': request_id, 'ok': False, 'error': str(e)})


def handle_open_path(msg):
    request_id = msg.get('requestId')
    try:
        path = msg.get('path') or core.get_download_dir(msg.get('source') or 'youtube')
        os.makedirs(path, exist_ok=True)
        os.startfile(path)
        send_message({'type': 'openPathResult', 'requestId': request_id, 'ok': True})
    except Exception as e:
        send_message({'type': 'openPathResult', 'requestId': request_id, 'ok': False, 'error': str(e)})


def handle_get_config(msg):
    send_message(_config_payload(msg.get('requestId')))


def handle_set_config(msg):
    request_id = msg.get('requestId')
    config = msg.get('config') or {}
    try:
        # Only keys present in `config` are touched, so saving one location
        # never pins the other one to its currently-inherited value.
        if 'downloadDir' in config:
            core.set_download_dir(config['downloadDir'], 'youtube')
        if 'twitterDownloadDir' in config:
            core.set_download_dir(config['twitterDownloadDir'], 'twitter')
        if 'webDownloadDir' in config:
            core.set_download_dir(config['webDownloadDir'], 'web')
        send_message(_config_payload(request_id))
    except Exception as e:
        send_message({'type': 'configResult', 'requestId': request_id, 'ok': False, 'error': str(e)})


def main():
    log.info('host started, pid=%s, frozen=%s', os.getpid(), getattr(sys, 'frozen', False))
    sweep_stale_jobs()
    core.sweep_tmp()
    threading.Thread(target=_writer_loop, daemon=True).start()
    try:
        while True:
            try:
                msg = read_message()
            except Exception:
                log.exception('failed to read/parse a message; exiting')
                break
            if msg is None:
                log.info('stdin closed, exiting')
                break

            msg_type = msg.get('type')
            if msg_type == 'ping':
                handle_ping(msg)
            elif msg_type == 'getConfig':
                handle_get_config(msg)
            elif msg_type == 'setConfig':
                handle_set_config(msg)
            elif msg_type == 'revealFile':
                handle_reveal_file(msg)
            elif msg_type == 'getJobStatus':
                handle_get_job_status(msg)
            elif msg_type == 'listDir':
                handle_list_dir(msg)
            elif msg_type == 'makeDir':
                handle_make_dir(msg)
            elif msg_type == 'openPath':
                handle_open_path(msg)
            elif msg_type == 'browseFolder':
                threading.Thread(target=handle_browse_folder, args=(msg,), daemon=True).start()
            elif msg_type == 'tweet':
                threading.Thread(target=handle_tweet, args=(msg,), daemon=True).start()
            elif msg_type == 'translate':
                threading.Thread(target=handle_translate, args=(msg,), daemon=True).start()
            elif msg_type == 'formats':
                threading.Thread(target=handle_formats, args=(msg,), daemon=True).start()
            elif msg_type == 'download':
                # Not a daemon thread: if the browser closes our stdin (EOF)
                # while a download is still running -- which does happen,
                # e.g. when Chrome tears down the service worker that owns
                # this connection -- the main loop above exits immediately,
                # but Python only actually terminates the process once every
                # non-daemon thread has finished. A daemon thread here would
                # get killed mid-download the instant that happens, freezing
                # the job at whatever it last reported. This is exactly what
                # lets the job survive long enough to finish and write its
                # final status, for a new (possibly Chromium) connection to
                # read back later via getJobStatus.
                threading.Thread(target=handle_download, args=(msg,), daemon=False).start()
            else:
                log.warning('unknown message type: %r', msg_type)
    except Exception:
        log.exception('fatal error in main loop')


if __name__ == '__main__':
    main()
