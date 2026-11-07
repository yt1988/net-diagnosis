# netdiag prototype test rig: serves ./page on 127.0.0.1:8899 and stores POST /results in ./results.json.
import http.server
import os

ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=os.path.join(ROOT, "page"), **kwargs)

    def do_POST(self):
        if self.path != "/results":
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        with open(os.path.join(ROOT, "results.json"), "wb") as f:
            f.write(body)
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(("127.0.0.1", 8899), Handler).serve_forever()
