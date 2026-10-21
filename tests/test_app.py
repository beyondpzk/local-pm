import copy
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import storage
from models import ValidationError
from storage import ConflictError, Store


def sample_backup():
    return {
        "schemaVersion": 1,
        "projects": [{"id": "p1", "name": "Project", "tasks": [
            {"id": "t1", "title": "Task", "done": False}]}],
        "roadmap": {"title": "Plan", "lanes": [{"id": "l1", "name": "Lane", "items": [
            {"id": "i1", "name": "Task", "start": "2026-09-01", "end": "2026-09-03",
             "progress": 20, "taskLink": {"projectId": "p1", "taskId": "t1"}}]}]},
    }


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="local-pm-test-")
        self.addCleanup(self.directory.cleanup)
        self.store = Store(self.directory.name)
        self.store.import_backup(sample_backup())

    def test_full_backup_roundtrip_and_pre_import_backup(self):
        before = self.store.export()
        result = self.store.import_backup(before)
        restored = self.store.export()
        self.assertEqual(restored["projects"], before["projects"])
        for key in ("lanes", "title", "startDate", "endDate"):
            self.assertEqual(restored["roadmap"][key], before["roadmap"][key])
        old = json.loads((Path(self.directory.name) / result["backup"]).read_text())
        self.assertEqual(old["projects"], before["projects"])
        self.assertEqual(old["roadmap"], before["roadmap"])

    def test_empty_legacy_import_clears_projects_but_preserves_plan(self):
        self.store.import_backup({"projects": []})
        self.assertEqual(self.store.projects()["projects"], [])
        item = self.store.roadmap()["lanes"][0]["items"][0]
        self.assertEqual(item["name"], "Task")
        self.assertNotIn("taskLink", item)

    def test_invalid_imports_do_not_change_files(self):
        cases = []
        for bad_tasks in (None, {}, [None], [7], [{"title": ""}], [{"title": "x", "done": "false"}],
                          [{"title": "x", "id": '\"><img src=x>'}],
                          [{"id": "same", "title": "a"}, {"id": "same", "title": "b"}]):
            cases.append({"projects": [{"name": "bad", "tasks": bad_tasks}]})
        bad_date = sample_backup()
        bad_date["roadmap"]["lanes"][0]["items"][0]["start"] = "2026-02-30"
        cases += [bad_date, {"schemaVersion": 2, "projects": [], "roadmap": {"lanes": []}},
                  {"schemaVersion": 1, "projects": []},
                  {"projects": [], "roadmap": {"lanes": [{}]}}]
        before = [p.read_bytes() for p in (self.store.projects_file, self.store.roadmap_file)]
        backup_count = len(list((Path(self.directory.name) / "backups").glob("*.json")))
        for value in cases:
            with self.subTest(value=value), self.assertRaises(ValidationError):
                self.store.import_backup(value)
            self.assertEqual(before, [p.read_bytes() for p in (self.store.projects_file, self.store.roadmap_file)])
        self.assertEqual(backup_count, len(list((Path(self.directory.name) / "backups").glob("*.json"))))

    def test_stale_save_rejected_including_after_import(self):
        a, b = self.store.roadmap(), self.store.roadmap()
        a["lanes"][0]["name"] = "Saved A"
        self.store.update_roadmap(a)
        with self.assertRaises(ConflictError):
            self.store.update_roadmap(b)
        self.assertEqual(self.store.roadmap()["lanes"][0]["name"], "Saved A")
        before_import = self.store.roadmap()
        self.store.import_backup(self.store.export())
        with self.assertRaises(ConflictError):
            self.store.update_roadmap(before_import)

    def test_direct_file_edit_invalidates_revision(self):
        previous = self.store.roadmap()
        raw = json.loads(self.store.roadmap_file.read_text())
        raw["title"] = "Manual edit"
        storage.atomic_write(self.store.roadmap_file, raw)
        with self.assertRaises(ConflictError):
            self.store.update_roadmap(previous)

    def test_concurrent_saves_have_one_winner(self):
        snapshot = self.store.roadmap()
        barrier = threading.Barrier(2)
        outcomes = []
        def save(title):
            body = copy.deepcopy(snapshot)
            body["title"] = title
            barrier.wait()
            try:
                self.store.update_roadmap(body)
                outcomes.append("saved")
            except ConflictError:
                outcomes.append("conflict")
        threads = [threading.Thread(target=save, args=(title,)) for title in ("A", "B")]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertCountEqual(outcomes, ["saved", "conflict"])

    def test_progress_and_completion_sync_both_directions(self):
        body = self.store.roadmap()
        body["lanes"][0]["items"][0]["progress"] = 100
        self.store.update_roadmap(body)
        self.assertTrue(self.store.projects()["projects"][0]["tasks"][0]["done"])
        stale = self.store.roadmap()
        self.store.modify_projects(lambda data: data["projects"][0]["tasks"][0].update(done=False))
        self.assertEqual(self.store.roadmap()["lanes"][0]["items"][0]["progress"], 0)
        with self.assertRaises(ConflictError):
            self.store.update_roadmap(stale)
        body = self.store.roadmap()
        body["lanes"][0]["items"][0]["progress"] = 35
        self.store.update_roadmap(body)
        self.store.modify_projects(lambda data: data["projects"][0].update(name="renamed"))
        self.assertEqual(self.store.roadmap()["lanes"][0]["items"][0]["progress"], 35)
        self.store.modify_projects(lambda data: data["projects"][0]["tasks"][0].update(done=True))
        self.assertEqual(self.store.roadmap()["lanes"][0]["items"][0]["progress"], 100)

    def test_delete_linked_task_keeps_roadmap_item(self):
        self.store.modify_projects(lambda data: data["projects"][0].update(tasks=[]))
        item = self.store.roadmap()["lanes"][0]["items"][0]
        self.assertEqual(item["progress"], 20)
        self.assertNotIn("taskLink", item)

    def test_missing_and_duplicate_links_rejected(self):
        body = self.store.roadmap()
        body["lanes"][0]["items"][0]["taskLink"]["taskId"] = "missing"
        with self.assertRaises(ValidationError): self.store.update_roadmap(body)
        body = self.store.roadmap()
        duplicate = copy.deepcopy(body["lanes"][0]["items"][0])
        duplicate["id"] = "i2"
        body["lanes"][0]["items"].append(duplicate)
        with self.assertRaises(ValidationError): self.store.update_roadmap(body)

    def test_interrupted_two_file_commit_recovers_on_restart(self):
        body = self.store.roadmap()
        body["lanes"][0]["items"][0]["progress"] = 100
        original = storage.atomic_write
        def fail_roadmap(path, value):
            if Path(path) == self.store.roadmap_file:
                raise OSError("simulated disk error")
            original(path, value)
        with patch("storage.atomic_write", side_effect=fail_roadmap), self.assertRaises(OSError):
            self.store.update_roadmap(body)
        restarted = Store(self.directory.name)
        restored = restarted.export()
        self.assertEqual(restored["roadmap"]["lanes"][0]["items"][0]["progress"], 100)
        self.assertTrue(restored["projects"][0]["tasks"][0]["done"])
        self.assertFalse(restarted.journal.exists())

    def test_backup_failure_prevents_import(self):
        before = self.store.projects_file.read_bytes()
        with patch("storage.atomic_write", side_effect=OSError("disk full")), self.assertRaises(OSError):
            self.store.import_backup({"projects": []})
        self.assertEqual(self.store.projects_file.read_bytes(), before)


class APITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="local-pm-api-test-")
        cls.original_store = app.store
        app.store = Store(cls.directory.name)
        class QuietHandler(app.APIHandler):
            def log_message(self, *args): pass
        cls.server = app.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        app.store = cls.original_store
        cls.directory.cleanup()

    def request(self, method, path, body=None, raw=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        payload = raw if raw is not None else json.dumps(body) if body is not None else None
        conn.request(method, path, payload, headers or {"Content-Type": "application/json"})
        response = conn.getresponse()
        result = response.status, json.loads(response.read())
        conn.close()
        return result

    def test_crud_export_and_empty_import(self):
        status, project = self.request("POST", "/api/projects", {"name": "new"})
        self.assertEqual(status, 201)
        status, task = self.request("POST", f'/api/projects/{project["id"]}/tasks', {"title": "todo"})
        self.assertEqual(status, 201)
        self.assertEqual(self.request("PUT", f'/api/projects/{project["id"]}/tasks/{task["id"]}', {"done": True})[0], 200)
        exported = self.request("GET", "/api/export")[1]
        self.assertEqual(exported["schemaVersion"], 1)
        self.assertIn("roadmap", exported)
        self.assertEqual(self.request("POST", "/api/import", {"projects": []})[1]["count"], 0)
        self.assertEqual(self.request("GET", "/api/projects")[1]["projects"], [])

    def test_bad_bodies_are_rejected(self):
        for raw in (b'{', b'[]', b'null', b'\xff', b'{"name":NaN}'):
            with self.subTest(raw=raw):
                self.assertEqual(self.request("POST", "/api/projects", raw=raw)[0], 400)
        self.assertEqual(self.request("POST", "/api/projects", raw=b'',
                                     headers={"Content-Length": str(app.MAX_BODY_SIZE + 1)})[0], 413)
        self.assertEqual(self.request("POST", "/api/projects", raw=b'',
                                     headers={"Content-Length": "-1"})[0], 400)

    def test_conflict_and_validation_status(self):
        snapshot = self.request("GET", "/api/roadmap")[1]
        self.assertEqual(self.request("PUT", "/api/roadmap", {**snapshot, "lanes": [{}]})[0], 400)
        self.assertEqual(self.request("PUT", "/api/roadmap", snapshot)[0], 200)
        self.assertEqual(self.request("PUT", "/api/roadmap", snapshot)[0], 409)


if __name__ == "__main__":
    unittest.main()
