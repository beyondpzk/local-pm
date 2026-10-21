"""Locked JSON storage, optimistic revisions and recoverable two-file commits."""

import copy
import datetime
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
import uuid

from models import (SCHEMA_VERSION, require, sync_from_projects, sync_to_projects,
                    validate_projects, validate_roadmap)


class ConflictError(ValueError):
    pass


def atomic_write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False, indent=2, allow_nan=False)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Store:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.projects_file = self.directory / "projects.json"
        self.roadmap_file = self.directory / "roadmap.json"
        self.journal = self.directory / ".pending.json"
        self.lock = threading.RLock()

    def _read(self, path, default):
        if not path.exists():
            return copy.deepcopy(default)
        with path.open(encoding="utf-8") as f:
            return json.load(f)

    def _recover(self):
        if self.journal.exists():
            pending = self._read(self.journal, {})
            atomic_write(self.projects_file, pending["projectsData"])
            atomic_write(self.roadmap_file, pending["roadmap"])
            self.journal.unlink()

    def _load(self):
        self._recover()
        return (self._read(self.projects_file, {"projects": []}),
                self._read(self.roadmap_file, {"lanes": []}))

    @staticmethod
    def revision(roadmap):
        # Hash the file as well as its generation so direct JSON edits are detected.
        raw = json.dumps(roadmap, ensure_ascii=False, sort_keys=True).encode("utf-8")
        return hashlib.sha256(raw).hexdigest()

    def projects(self):
        with self.lock:
            return self._load()[0]

    def roadmap(self):
        with self.lock:
            roadmap = self._load()[1]
            return {**roadmap, "revision": self.revision(roadmap)}

    def _backup_payload(self, projects, roadmap):
        return {"schemaVersion": SCHEMA_VERSION, "exportedAt": datetime.datetime.now().isoformat(),
                "projects": projects["projects"], "roadmap": roadmap}

    def export(self):
        with self.lock:
            return self._backup_payload(*self._load())

    def _commit(self, projects, roadmap):
        # Once the journal is durable, the whole transaction can be completed on
        # the next read or after restart, even if either file replacement fails.
        atomic_write(self.journal, {"projectsData": projects, "roadmap": roadmap})
        self._recover()

    def modify_projects(self, modifier):
        with self.lock:
            projects, roadmap = self._load()
            before = copy.deepcopy(roadmap)
            result = modifier(projects)
            sync_from_projects(projects["projects"], roadmap)
            if roadmap != before:
                roadmap["_generation"] = str(uuid.uuid4())
                self._commit(projects, roadmap)
            else:
                atomic_write(self.projects_file, projects)
            return result

    def update_roadmap(self, body):
        with self.lock:
            projects, old = self._load()
            if body.get("revision") != self.revision(old):
                raise ConflictError("其他页面或项目任务已更新规划。请先下载本页草稿，再加载最新版本。")
            candidate = {**old, **body}
            candidate.pop("revision", None)
            roadmap = validate_roadmap(candidate)
            sync_to_projects(projects["projects"], roadmap)
            roadmap["_generation"] = str(uuid.uuid4())
            self._commit(projects, roadmap)
            return {**roadmap, "revision": self.revision(roadmap)}

    def import_backup(self, body):
        require(isinstance(body, dict), "备份必须是对象")
        if "schemaVersion" in body:
            require(type(body["schemaVersion"]) is int and body["schemaVersion"] == SCHEMA_VERSION,
                    "不支持此备份版本")
            require("roadmap" in body, "完整备份缺少 roadmap")
        projects = {"projects": validate_projects(body.get("projects"))}
        incoming = validate_roadmap(body["roadmap"]) if "roadmap" in body else None
        with self.lock:
            old_projects, old_roadmap = self._load()
            roadmap = incoming if incoming is not None else copy.deepcopy(old_roadmap)
            if incoming is not None:
                # A full backup must describe one consistent set of linked tasks.
                checked = copy.deepcopy(projects["projects"])
                sync_to_projects(checked, roadmap)
                require(checked == projects["projects"], "备份中关联任务的完成状态与进度不一致")
            else:
                sync_from_projects(projects["projects"], roadmap)
            roadmap.pop("revision", None)
            roadmap["_generation"] = str(uuid.uuid4())
            stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
            backup = Path("backups") / f"before-import-{stamp}-{uuid.uuid4().hex[:8]}.json"
            atomic_write(self.directory / backup, self._backup_payload(old_projects, old_roadmap))
            self._commit(projects, roadmap)
            return {"count": len(projects["projects"]), "backup": str(backup),
                    "roadmapRestored": incoming is not None}
