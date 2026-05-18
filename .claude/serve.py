#!/usr/bin/env python3
"""Static file server for kesefle preview.

Avoids `python3 -m http.server` because that module evaluates os.getcwd() at
import time (for argparse defaults). If the launcher inherits a deleted/
inaccessible cwd, that crashes. This script first chdir's into a known-good
directory, then builds the handler/server programmatically.
"""
import os
import sys

ROOT = "/Users/stevenrancohen/Documents/Claude/Projects/kesefle"
PORT = 5274

# Get to a real directory before importing anything that might call getcwd()
try:
    os.chdir(ROOT)
except Exception as e:
    print(f"FATAL: cannot chdir to {ROOT}: {e}", file=sys.stderr)
    sys.exit(2)

import http.server  # noqa: E402
import socketserver  # noqa: E402

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
    print(f"serving kesefle on http://127.0.0.1:{PORT}", flush=True)
    httpd.serve_forever()
