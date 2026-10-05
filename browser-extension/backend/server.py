#!/usr/bin/env python
# coding: utf-8
"""Local HTTP backend for the twtdl browser extension (dev/test use).

This is the fast local dev loop: curl-testable, no registry/native-messaging
setup needed. The packaged extension talks to native-host/host.py instead,
which shares the actual extraction/download logic in core.py.

Usage:
    python server.py [port]

The first run generates browser-extension/backend/token.txt containing an
auth token. Paste that token into the extension's options page so the
extension is allowed to talk to this server.
"""

from __future__ import unicode_literals

import json
import os
import secrets
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BACKEND_DIR)

import core  # noqa: E402
import errors  # noqa: E402
import yt_dlp  # noqa: E402

TOKEN_PATH = os.path.join(BACKEND_DIR, 'token.txt')
DEFAULT_PORT = 4325

jobs = {}
jobs_lock = threading.Lock()


def get_or_create_token():
    if os.path.exists(TOKEN_PATH):
        with open(TOKEN_PATH, 'r') as f:
            token = f.read().strip()
            if token:
                return token
    token = secrets.token_urlsafe(24)
    with open(TOKEN_PATH, 'w') as f:
        f.write(token)
    return token


def run_download_job(job_id, url, mode, quality, options=None, audio=None):
    def on_progress(**kwargs):
        with jobs_lock:
            jobs[job_id].update(kwargs)
    if options is not None:
        core.run_twitter_download(url, options, on_progress)
    else:
        core.run_download(url, mode, quality, on_progress, audio=audio)


class Handler(BaseHTTPRequestHandler):
    server_version = 'ytdl-ext-backend/0.1'

    def log_message(self, fmt, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

    def _cors_origin(self):
        origin = self.headers.get('Origin', '')
        if origin.startswith('moz-extension://'):
            return origin
        return None

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        origin = self._cors_origin()
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.end_headers()
        self.wfile.write(body)

    def _check_auth(self):
        expected = get_or_create_token()
        got = self.headers.get('X-Auth-Token', '')
        return secrets.compare_digest(got, expected)

    def do_OPTIONS(self):
        self.send_response(204)
        origin = self._cors_origin()
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token')
        self.send_header('Access-Control-Max-Age', '600')
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/ping':
            self._send_json(200, {'ok': True, 'version': yt_dlp.version.__version__})
            return

        if not self._check_auth():
            self._send_json(403, {'error': 'Invalid or missing X-Auth-Token'})
            return

        if parsed.path == '/formats':
            qs = parse_qs(parsed.query)
            url = (qs.get('url') or [''])[0]
            try:
                info = core.fetch_formats(url)
            except ValueError as e:
                self._send_json(400, {'error': str(e)})
                return
            except Exception as e:
                self._send_json(502, errors.classify_error(e))
                return
            self._send_json(200, info)
            return

        if parsed.path == '/tweet':
            url = (parse_qs(parsed.query).get('url') or [''])[0]
            try:
                self._send_json(200, core.get_tweet_info(url))
            except Exception as e:
                self._send_json(502, errors.classify_error(e))
            return

        if parsed.path == '/status':
            qs = parse_qs(parsed.query)
            job_id = (qs.get('id') or [''])[0]
            with jobs_lock:
                job = jobs.get(job_id)
            if job is None:
                self._send_json(404, {'error': 'Unknown job id'})
                return
            self._send_json(200, job)
            return

        self._send_json(404, {'error': 'Not found'})

    def do_POST(self):
        if not self._check_auth():
            self._send_json(403, {'error': 'Invalid or missing X-Auth-Token'})
            return

        parsed = urlparse(self.path)
        if parsed.path != '/download':
            self._send_json(404, {'error': 'Not found'})
            return

        length = int(self.headers.get('Content-Length', 0))
        try:
            body = json.loads(self.rfile.read(length) or b'{}')
        except ValueError:
            self._send_json(400, {'error': 'Invalid JSON body'})
            return

        url = body.get('url', '')
        mode = body.get('mode', '')
        quality = body.get('quality')

        options = body.get('options') if body.get('source') == 'twitter' else None
        try:
            if options is not None:
                options = core.validate_twitter_request(url, options)
            else:
                core.validate_download_request(url, mode, quality, body.get('audio'))
        except ValueError as e:
            self._send_json(400, {'error': str(e)})
            return

        job_id = uuid.uuid4().hex
        with jobs_lock:
            jobs[job_id] = {'status': 'starting', 'percent': 0}

        thread = threading.Thread(target=run_download_job, args=(job_id, url, mode, quality, options, body.get('audio')), daemon=True)
        thread.start()

        self._send_json(200, {'job_id': job_id})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    core.ensure_download_dir()
    token = get_or_create_token()
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print('twtdl extension backend')
    print('  listening on http://127.0.0.1:%d' % port)
    print('  downloads saved to %s' % core.get_download_dir())
    print('  auth token (paste into the extension options page): %s' % token)
    print('  (token also saved to %s)' % TOKEN_PATH)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
