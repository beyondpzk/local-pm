"""Validation and task-link rules, independent of HTTP and file storage."""

import copy
import datetime
import re
import uuid

SCHEMA_VERSION = 1
VALID_PROJECT_STATUS = ("active", "archived", "done")
VALID_PRIORITY = ("high", "medium", "low")


class ValidationError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise ValidationError(message)


def text(value, path, nonempty=False):
    require(isinstance(value, str), f"{path} 必须是文本")
    require(not nonempty or bool(value.strip()), f"{path} 不能为空")
    return value


def identifier(obj, path, seen):
    value = obj.setdefault("id", str(uuid.uuid4()))
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value),
            f"{path}.id 格式无效")
    require(value not in seen, f"{path}.id 重复")
    seen.add(value)


def date(value, path, optional=False):
    if optional and value == "":
        return
    require(isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value),
            f"{path} 必须为 YYYY-MM-DD")
    try:
        datetime.date.fromisoformat(value)
    except ValueError:
        raise ValidationError(f"{path} 不是有效日期") from None


def timestamps(obj, path):
    for key in ("createdAt", "updatedAt"):
        value = obj.setdefault(key, datetime.datetime.now().isoformat(timespec="seconds"))
        text(value, f"{path}.{key}")
        try:
            datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            raise ValidationError(f"{path}.{key} 不是有效时间") from None


def validate_projects(value):
    require(isinstance(value, list), "projects 必须是数组")
    projects = copy.deepcopy(value)
    project_ids = set()
    for i, project in enumerate(projects):
        path = f"projects[{i}]"
        require(isinstance(project, dict), f"{path} 必须是对象")
        identifier(project, path, project_ids)
        text(project.get("name"), f"{path}.name", True)
        text(project.setdefault("description", ""), f"{path}.description")
        require(project.setdefault("status", "active") in VALID_PROJECT_STATUS, f"{path}.status 无效")
        require(type(project.setdefault("pinned", False)) is bool, f"{path}.pinned 必须是布尔值")
        timestamps(project, path)
        tasks = project.setdefault("tasks", [])
        require(isinstance(tasks, list), f"{path}.tasks 必须是数组")
        task_ids = set()
        for j, task in enumerate(tasks):
            task_path = f"{path}.tasks[{j}]"
            require(isinstance(task, dict), f"{task_path} 必须是对象")
            identifier(task, task_path, task_ids)
            text(task.get("title"), f"{task_path}.title", True)
            require(type(task.setdefault("done", False)) is bool, f"{task_path}.done 必须是布尔值")
            require(task.setdefault("priority", "medium") in VALID_PRIORITY, f"{task_path}.priority 无效")
            timestamps(task, task_path)
    return projects


def validate_roadmap(value):
    require(isinstance(value, dict), "roadmap 必须是对象")
    roadmap = copy.deepcopy(value)
    require(isinstance(roadmap.get("lanes"), list), "roadmap.lanes 必须是数组")
    text(roadmap.setdefault("title", "研发进度规划"), "roadmap.title")
    for key in ("startDate", "endDate"):
        date(roadmap.setdefault(key, ""), f"roadmap.{key}", optional=True)
    require(not (roadmap["startDate"] and roadmap["endDate"])
            or roadmap["startDate"] <= roadmap["endDate"], "规划开始日期不能晚于结束日期")
    lane_ids, item_ids, links = set(), set(), set()
    for i, lane in enumerate(roadmap["lanes"]):
        path = f"lanes[{i}]"
        require(isinstance(lane, dict), f"{path} 必须是对象")
        identifier(lane, path, lane_ids)
        text(lane.get("name"), f"{path}.name", True)
        text(lane.setdefault("group", ""), f"{path}.group")
        require(isinstance(lane.get("items"), list), f"{path}.items 必须是数组")
        for j, item in enumerate(lane["items"]):
            ip = f"{path}.items[{j}]"
            require(isinstance(item, dict), f"{ip} 必须是对象")
            identifier(item, ip, item_ids)
            text(item.get("name"), f"{ip}.name", True)
            for key in ("start", "end"):
                date(item.get(key), f"{ip}.{key}")
            require(item["start"] <= item["end"], f"{ip} 开始日期不能晚于结束日期")
            progress = item.setdefault("progress", 0)
            require(type(progress) is int and 0 <= progress <= 100, f"{ip}.progress 必须是 0–100 的整数")
            milestones = item.setdefault("milestones", [])
            require(isinstance(milestones, list), f"{ip}.milestones 必须是数组")
            for k, milestone in enumerate(milestones):
                mp = f"{ip}.milestones[{k}]"
                require(isinstance(milestone, dict), f"{mp} 必须是对象")
                date(milestone.get("date"), f"{mp}.date")
                text(milestone.get("name"), f"{mp}.name", True)
            link = item.get("taskLink")
            if link is not None:
                require(isinstance(link, dict), f"{ip}.taskLink 必须是对象")
                for key in ("projectId", "taskId"):
                    text(link.get(key), f"{ip}.taskLink.{key}", True)
                pair = (link["projectId"], link["taskId"])
                require(pair not in links, "一个项目任务只能关联一个甘特图任务")
                links.add(pair)
    return roadmap


def task_index(projects):
    return {(p["id"], t["id"]): (p, t) for p in projects for t in p["tasks"]}


def linked_items(roadmap):
    for lane in roadmap["lanes"]:
        for item in lane["items"]:
            if item.get("taskLink"):
                link = item["taskLink"]
                yield item, (link["projectId"], link["taskId"])


def sync_from_projects(projects, roadmap):
    """Completion wins on project edits; deleting a task only removes its link."""
    index = task_index(projects)
    for item, pair in linked_items(roadmap):
        if pair not in index:
            item.pop("taskLink")
        elif index[pair][1]["done"]:
            item["progress"] = 100
        elif item.get("progress", 0) == 100:
            item["progress"] = 0


def sync_to_projects(projects, roadmap):
    index = task_index(projects)
    for item, pair in linked_items(roadmap):
        require(pair in index, "关联的项目任务不存在，请重新选择或取消关联")
        project, task = index[pair]
        done = item["progress"] == 100
        if task["done"] != done:
            task["done"] = done
            task["updatedAt"] = project["updatedAt"] = datetime.datetime.now().isoformat(timespec="seconds")
