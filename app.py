#!/usr/bin/env python3
"""本地项目管理工具：一个基于 Python 标准库的轻量级 Web 服务。

项目和甘特图以人类可读的 JSON 形式保存在 ./data/。
"""

import datetime
import functools
import json
import os
import re
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

from models import VALID_PRIORITY, VALID_PROJECT_STATUS, ValidationError, require, text
from storage import ConflictError, Store

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(BASE_DIR, "data", "projects.json")
ROADMAP_FILE = os.path.join(BASE_DIR, "data", "roadmap.json")
STATIC_DIR = os.path.join(BASE_DIR, "static")
HOST = "127.0.0.1"
PORT = 8765
MAX_BODY_SIZE = 10 * 1024 * 1024  # 10 MB

store = Store(os.path.dirname(DATA_FILE))

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
}


def now_iso() -> str:
    return datetime.datetime.now().isoformat(timespec="seconds")


def modify_data(modifier_fn):
    return store.modify_projects(modifier_fn)


class RequestError(ValueError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def api_errors(fn):
    @functools.wraps(fn)
    def wrapped(self):
        try:
            fn(self)
        except RequestError as error:
            self.send_json(error.status, {"error": str(error)})
        except ConflictError as error:
            self.send_json(409, {"error": str(error)})
        except ValidationError as error:
            self.send_json(400, {"error": str(error)})
        except (OSError, json.JSONDecodeError) as error:
            self.log_message("storage error: %s", error)
            self.send_json(500, {"error": "无法读取或保存本地数据，请检查数据文件和磁盘后重试"})
    return wrapped


def validate_fields(body, task=False):
    for field in (("title",) if task else ("name", "description")):
        if field in body:
            text(body[field], field, nonempty=field != "description")
    flag = "done" if task else "pinned"
    if flag in body:
        require(type(body[flag]) is bool, f"{flag} 必须是布尔值")
    enum, choices = ("priority", VALID_PRIORITY) if task else ("status", VALID_PROJECT_STATUS)
    if enum in body:
        require(body[enum] in choices, f"{enum} 无效")


class APIHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[{now_iso()}] {self.address_string()} {fmt % args}")

    def send_json(self, status: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            raise RequestError(400, "Content-Length 无效") from None
        if length < 0:
            raise RequestError(400, "Content-Length 无效")
        if length > MAX_BODY_SIZE:
            raise RequestError(413, "request body too large")
        try:
            def reject_constant(value):
                raise ValueError(value)
            body = json.loads(self.rfile.read(length).decode("utf-8"), parse_constant=reject_constant)
        except (ValueError, UnicodeDecodeError):
            raise RequestError(400, "请求必须是有效的 UTF-8 JSON") from None
        require(isinstance(body, dict), "请求必须是 JSON 对象")
        return body

    def serve_static(self, rel_path: str) -> None:
        if rel_path.startswith("/") or rel_path.startswith("\\"):
            self.send_json(404, {"error": "not found"})
            return
        resolved = os.path.normpath(os.path.join(STATIC_DIR, rel_path))
        if not resolved.startswith(os.path.normpath(STATIC_DIR) + os.sep):
            self.send_json(404, {"error": "not found"})
            return
        if not os.path.isfile(resolved):
            self.send_json(404, {"error": "not found"})
            return
        ext = os.path.splitext(resolved)[1].lower()
        ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
        with open(resolved, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    @api_errors
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/":
            self.serve_static("index.html")
        elif path == "/roadmap":
            self.serve_static("roadmap.html")
        elif path == "/timeline":
            self.serve_static("项目进度时间轴_可编辑.html")
        elif path.startswith("/static/"):
            self.serve_static(unquote(path[len("/static/"):]))
        elif path == "/api/projects":
            self.send_json(200, store.projects())
        elif path == "/api/export":
            self.send_json(200, store.export())
        elif path == "/api/roadmap":
            self.send_json(200, store.roadmap())
        else:
            self.send_json(404, {"error": "not found"})

    @api_errors
    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/projects":
            self.create_project()
        elif path == "/api/import":
            self.import_data()
        else:
            m = re.match(r"^/api/projects/([^/]+)/tasks$", path)
            if m:
                self.create_task(m.group(1))
            else:
                self.send_json(404, {"error": "not found"})

    @api_errors
    def do_PUT(self):
        path = urlparse(self.path).path
        if path == "/api/roadmap":
            self.update_roadmap()
            return
        m = re.match(r"^/api/projects/([^/]+)$", path)
        if m:
            self.update_project(m.group(1))
            return
        m = re.match(r"^/api/projects/([^/]+)/tasks/([^/]+)$", path)
        if m:
            self.update_task(m.group(1), m.group(2))
            return
        self.send_json(404, {"error": "not found"})

    @api_errors
    def do_DELETE(self):
        path = urlparse(self.path).path
        m = re.match(r"^/api/projects/([^/]+)$", path)
        if m:
            self.delete_project(m.group(1))
            return
        m = re.match(r"^/api/projects/([^/]+)/tasks/([^/]+)$", path)
        if m:
            self.delete_task(m.group(1), m.group(2))
            return
        self.send_json(404, {"error": "not found"})

    def create_project(self):
        body = self.read_body()
        validate_fields(body)
        name = str(body.get("name", "")).strip()
        if not name:
            self.send_json(400, {"error": "name is required"})
            return
        status = body.get("status", "active")
        if status not in VALID_PROJECT_STATUS:
            status = "active"
        pinned = body.get("pinned", False)

        def _add(data):
            project = {
                "id": str(uuid.uuid4()),
                "name": name,
                "description": str(body.get("description", "")),
                "status": status,
                "pinned": pinned if isinstance(pinned, bool) else False,
                "createdAt": now_iso(),
                "updatedAt": now_iso(),
                "tasks": [],
            }
            data["projects"].append(project)
            return project

        project = modify_data(_add)
        self.send_json(201, project)

    def update_project(self, pid: str):
        body = self.read_body()
        validate_fields(body)

        def _update(data):
            p = next((x for x in data["projects"] if x["id"] == pid), None)
            if not p:
                return None
            if "name" in body:
                name = str(body["name"]).strip()
                if name:
                    p["name"] = name
            if "description" in body:
                p["description"] = str(body["description"])
            if "status" in body and body["status"] in VALID_PROJECT_STATUS:
                p["status"] = body["status"]
            if "pinned" in body:
                p["pinned"] = bool(body["pinned"])
            p["updatedAt"] = now_iso()
            return p

        p = modify_data(_update)
        if p is None:
            self.send_json(404, {"error": "project not found"})
        else:
            self.send_json(200, p)

    def delete_project(self, pid: str):
        def _delete(data):
            before = len(data["projects"])
            data["projects"] = [x for x in data["projects"] if x["id"] != pid]
            return len(data["projects"]) < before

        deleted = modify_data(_delete)
        if not deleted:
            self.send_json(404, {"error": "project not found"})
        else:
            self.send_json(200, {"deleted": pid})

    def create_task(self, pid: str):
        body = self.read_body()
        validate_fields(body, task=True)
        title = str(body.get("title", "")).strip()
        if not title:
            self.send_json(400, {"error": "title is required"})
            return
        priority = body.get("priority", "medium")
        if priority not in VALID_PRIORITY:
            priority = "medium"

        def _add(data):
            p = next((x for x in data["projects"] if x["id"] == pid), None)
            if not p:
                return None
            task = {
                "id": str(uuid.uuid4()),
                "title": title,
                "done": bool(body.get("done", False)),
                "priority": priority,
                "createdAt": now_iso(),
                "updatedAt": now_iso(),
            }
            p["tasks"].append(task)
            p["updatedAt"] = now_iso()
            return task

        task = modify_data(_add)
        if task is None:
            self.send_json(404, {"error": "project not found"})
        else:
            self.send_json(201, task)

    def update_task(self, pid: str, tid: str):
        body = self.read_body()
        validate_fields(body, task=True)

        def _update(data):
            p = next((x for x in data["projects"] if x["id"] == pid), None)
            if not p:
                return None
            t = next((x for x in p["tasks"] if x["id"] == tid), None)
            if not t:
                return None
            if "title" in body:
                title = str(body["title"]).strip()
                if title:
                    t["title"] = title
            if "done" in body:
                t["done"] = bool(body["done"])
            if "priority" in body and body["priority"] in VALID_PRIORITY:
                t["priority"] = body["priority"]
            t["updatedAt"] = now_iso()
            p["updatedAt"] = now_iso()
            return t

        t = modify_data(_update)
        if t is None:
            self.send_json(404, {"error": "project or task not found"})
        else:
            self.send_json(200, t)

    def delete_task(self, pid: str, tid: str):
        def _delete(data):
            p = next((x for x in data["projects"] if x["id"] == pid), None)
            if not p:
                return None
            before = len(p["tasks"])
            p["tasks"] = [x for x in p["tasks"] if x["id"] != tid]
            if len(p["tasks"]) < before:
                p["updatedAt"] = now_iso()
                return {"deleted": tid}
            return None

        result = modify_data(_delete)
        if result is None:
            self.send_json(404, {"error": "project or task not found"})
        else:
            self.send_json(200, result)

    def update_roadmap(self):
        body = self.read_body()
        require(isinstance(body.get("lanes"), list), "roadmap must contain lanes array")
        self.send_json(200, store.update_roadmap(body))

    def import_data(self):
        body = self.read_body()
        self.send_json(200, store.import_backup(body))


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), APIHandler)
    print(f"Local PM running at http://{HOST}:{PORT}")
    print(f"Data file: {DATA_FILE}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()
