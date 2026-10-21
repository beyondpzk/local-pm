#!/usr/bin/env python3
"""本地项目管理工具：一个基于 Python 标准库的轻量级 Web 服务。

所有数据以人类可读的 JSON 形式保存在 ./data/projects.json。
"""

import datetime
import json
import os
import re
import shutil
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(BASE_DIR, "data", "projects.json")
ROADMAP_FILE = os.path.join(BASE_DIR, "data", "roadmap.json")
STATIC_DIR = os.path.join(BASE_DIR, "static")
HOST = "127.0.0.1"
PORT = 8765
MAX_BODY_SIZE = 10 * 1024 * 1024  # 10 MB

_data_lock = threading.Lock()
_roadmap_lock = threading.Lock()

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
}

VALID_PROJECT_STATUS = {"active", "archived", "done"}
VALID_PRIORITY = {"high", "medium", "low"}


def now_iso() -> str:
    return datetime.datetime.now().isoformat(timespec="seconds")


def ensure_data() -> None:
    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    if not os.path.exists(DATA_FILE):
        with open(DATA_FILE, "w", encoding="utf-8") as f:
            json.dump({"projects": []}, f, ensure_ascii=False, indent=2)
            f.write("\n")


def load_data() -> dict:
    ensure_data()
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_data(data: dict) -> None:
    ensure_data()
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    shutil.move(tmp, DATA_FILE)


def ensure_roadmap() -> None:
    os.makedirs(os.path.dirname(ROADMAP_FILE), exist_ok=True)
    if not os.path.exists(ROADMAP_FILE):
        with open(ROADMAP_FILE, "w", encoding="utf-8") as f:
            json.dump({"lanes": []}, f, ensure_ascii=False, indent=2)
            f.write("\n")


def load_roadmap() -> dict:
    ensure_roadmap()
    with open(ROADMAP_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_roadmap(data: dict) -> None:
    ensure_roadmap()
    tmp = ROADMAP_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    shutil.move(tmp, ROADMAP_FILE)


def modify_roadmap(modifier_fn):
    """线程安全地加载、修改并保存 roadmap 数据。"""
    with _roadmap_lock:
        data = load_roadmap()
        result = modifier_fn(data)
        save_roadmap(data)
    return result


def modify_data(modifier_fn):
    """线程安全地加载、修改并保存数据。"""
    with _data_lock:
        data = load_data()
        result = modifier_fn(data)
        save_data(data)
    return result


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
        length = int(self.headers.get("Content-Length", 0))
        if length > MAX_BODY_SIZE:
            self.send_json(413, {"error": "request body too large"})
            return {}
        if length:
            raw = self.rfile.read(length).decode("utf-8")
            try:
                return json.loads(raw) if raw else {}
            except (json.JSONDecodeError, UnicodeDecodeError):
                return {}
        return {}

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
        elif path == "/api/projects" or path == "/api/export":
            self.send_json(200, load_data())
        elif path == "/api/roadmap":
            self.send_json(200, load_roadmap())
        else:
            self.send_json(404, {"error": "not found"})

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
        if not isinstance(body, dict) or "lanes" not in body or not isinstance(body["lanes"], list):
            self.send_json(400, {"error": "roadmap must contain lanes array"})
            return

        def _update(data):
            data["lanes"] = body["lanes"]
            if "title" in body:
                data["title"] = str(body["title"])
            if "startDate" in body:
                data["startDate"] = str(body["startDate"])
            if "endDate" in body:
                data["endDate"] = str(body["endDate"])
            if "okr" in body:
                if body["okr"] is None:
                    data.pop("okr", None)
                else:
                    data["okr"] = body["okr"]
                data.pop("q3_okr", None)
            return data

        roadmap = modify_roadmap(_update)
        self.send_json(200, roadmap)

    def import_data(self):
        body = self.read_body()
        if "projects" not in body or not isinstance(body["projects"], list):
            self.send_json(400, {"error": "projects array required"})
            return

        for i, p in enumerate(body["projects"]):
            if not isinstance(p, dict):
                self.send_json(400, {"error": f"projects[{i}] is not an object"})
                return
            if not isinstance(p.get("name", ""), str) or not str(p.get("name", "")).strip():
                self.send_json(400, {"error": f"projects[{i}].name is required"})
                return

        def _import(data):
            for p in body["projects"]:
                p.setdefault("id", str(uuid.uuid4()))
                p.setdefault("tasks", [])
                p["status"] = p.get("status", "active")
                if p["status"] not in VALID_PROJECT_STATUS:
                    p["status"] = "active"
                p.setdefault("description", "")
                p.setdefault("pinned", False)
                for j, t in enumerate(p["tasks"]):
                    if isinstance(t, dict):
                        t.setdefault("id", str(uuid.uuid4()))
                        t.setdefault("title", "")
                        t.setdefault("done", False)
                        priority = t.get("priority", "medium")
                        t["priority"] = priority if priority in VALID_PRIORITY else "medium"
                data["projects"] = body["projects"]
            return len(data["projects"])

        count = modify_data(_import)
        self.send_json(200, {"count": count})


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
