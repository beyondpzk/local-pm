#!/usr/bin/env python3
"""Serve only the shared timeline, with revision checks and atomic JSON storage."""
import argparse
import datetime
import re
import uuid
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

MAX_BODY = 5 * 1024 * 1024


def validate(data):
    if not isinstance(data, dict):
        raise ValueError('项目必须是 JSON 对象')
    for key in ('nodes', 'texts', 'arrows', 'lanes'):
        if not isinstance(data.get(key), list):
            raise ValueError('缺少项目字段：' + key)
    for key in ('nodes', 'texts', 'lanes'):
        for item in data[key]:
            if not isinstance(item, dict) or not isinstance(item.get('id'), str):
                raise ValueError('对象缺少 ID')
            for axis in (('y',) if key == 'lanes' else ('x', 'y')):
                if type(item.get(axis)) not in (int, float) or not math.isfinite(item[axis]):
                    raise ValueError('对象坐标无效')
    for arrow in data['arrows']:
        if not isinstance(arrow, dict) or not isinstance(arrow.get('id'), str) or not isinstance(arrow.get('points'), list) or len(arrow['points']) < 2:
            raise ValueError('箭头数据无效')
        for point in arrow['points']:
            if not isinstance(point, dict) or any(type(point.get(k)) not in (int, float) or not math.isfinite(point[k]) for k in ('x', 'y')):
                raise ValueError('箭头坐标无效')
    if not isinstance(data.get('months'), list) or not 1 <= len(data['months']) <= 24:
        raise ValueError('月份数据无效')
    for month in data['months']:
        if not isinstance(month, dict) or any(type(month.get(k)) not in (int, float) or not math.isfinite(month[k]) for k in ('year', 'month', 'width')):
            raise ValueError('月份数据无效')
    if not isinstance(data.get('view'), dict) or any(type(data['view'].get(k)) not in (int, float) or not 0 < data['view'][k] < 10000000 for k in ('w', 'h')):
        raise ValueError('画布尺寸无效')


def change_summary(old, new):
    if old is None:
        return '导入项目'
    changes = []
    if old.get('title') != new.get('title'):
        changes.append('修改项目名称')
    if old.get('months') != new.get('months'):
        changes.append('调整月份')
    for key, name in (('lanes','泳道'), ('nodes','节点'), ('texts','文字'), ('arrows','箭头')):
        before = {item['id']: item for item in old[key]}
        after = {item['id']: item for item in new[key]}
        added, removed = len(after.keys()-before.keys()), len(before.keys()-after.keys())
        edited = sum(before[k] != after[k] for k in before.keys() & after.keys())
        counts = [f'{label}{count}' for label,count in (('新增',added),('修改',edited),('删除',removed)) if count]
        if counts:
            changes.append(name+'：'+'、'.join(counts))
    return '；'.join(changes) or '调整画布设置'


def encoded(data):
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def atomic_write(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.pending-')
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(body)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class TimelineServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, web_root, state_dir):
        self.web_root = Path(web_root)
        self.state_dir = Path(state_dir)
        self.lock = threading.Lock()
        super().__init__(address, Handler)

    def record(self, path):
        saved = json.loads(path.read_text())
        if 'timeline' in saved and 'revision' in saved:
            validate(saved['timeline'])
            return saved
        validate(saved)
        return {'revision': hashlib.sha256(encoded(saved)).hexdigest(), 'timeline': saved,
                'updatedAt': datetime.datetime.fromtimestamp(path.stat().st_mtime, datetime.timezone.utc).isoformat(),
                'updatedBy': '初始导入（未记录编辑人）', 'summary': '导入项目', 'restoredFrom': None}

    def read_project(self):
        path = self.state_dir / 'timeline.json'
        if not path.exists():
            return {'revision': 'empty', 'timeline': None, 'updatedAt': None, 'updatedBy': None}
        return self.record(path)

    def history_record(self, revision):
        if not re.fullmatch(r'[a-f0-9]{32}|[a-f0-9]{64}', revision):
            raise FileNotFoundError('版本不存在')
        current = self.read_project()
        if current['revision'] == revision:
            return current
        return self.record(self.state_dir / 'backups' / (revision + '.json'))

    def history(self):
        current = self.read_project()
        records = [current] if current['timeline'] is not None else []
        for path in (self.state_dir / 'backups').glob('*.json'):
            record = self.record(path)
            if record['revision'] != current['revision']:
                records.append(record)
        records.sort(key=lambda r: r.get('updatedAt') or '', reverse=True)
        return [{k: v for k, v in record.items() if k != 'timeline'} for record in records[:100]]


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(20)

    def reply(self, code, body, content_type='application/json; charset=utf-8'):
        if not isinstance(body, bytes):
            body = encoded(body)
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        try:
            path = urlsplit(self.path).path
            if path in ('/', '/timeline'):
                html = (self.server.web_root / '项目进度时间轴_可编辑.html').read_text()
                config = '<script id="timelineServerConfig" type="application/json">{"shared":true}</script>\n<script id="timelineSaveQueue" src="/save-queue.js"></script>\n'
                html = html.replace('<script>\n', config + '<script>\n', 1)
                self.reply(200, html.encode(), 'text/html; charset=utf-8')
            elif path == '/save-queue.js':
                self.reply(200, (self.server.web_root / 'save-queue.js').read_bytes(), 'text/javascript; charset=utf-8')
            elif path == '/api/timeline':
                with self.server.lock:
                    data = self.server.read_project()
                self.reply(200, data)
            elif path == '/api/history':
                with self.server.lock:
                    history = self.server.history()
                self.reply(200, {'versions': history})
            elif path.startswith('/api/history/'):
                with self.server.lock:
                    try:
                        record = self.server.history_record(path.removeprefix('/api/history/'))
                    except FileNotFoundError:
                        return self.reply(404, {'error': '版本不存在'})
                self.reply(200, record)
            elif path == '/health':
                self.reply(200, {'ok': True})
            else:
                self.reply(404, {'error': '页面不存在'})
        except (OSError, ValueError):
            self.log_error('Cannot read timeline state')
            self.reply(500, {'error': '无法读取服务数据，请联系维护者'})

    def do_PUT(self):
        if urlsplit(self.path).path != '/api/timeline':
            return self.reply(404, {'error': '接口不存在'})
        # Require a same-origin JSON request; no cross-origin write permissions.
        origin = self.headers.get('Origin')
        if origin and origin != 'http://' + self.headers.get('Host', ''):
            return self.reply(403, {'error': '不允许跨站修改'})
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.reply(415, {'error': '需要 application/json'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_BODY:
                return self.reply(413, {'error': '数据大小超出限制'})
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError('请求格式无效')
            editor = payload.get('editor')
            if not isinstance(editor, str) or not 1 <= len(editor.strip()) <= 40:
                raise ValueError('请填写编辑姓名（1—40 字）')
            editor = editor.strip()
            if 'restoreRevision' not in payload:
                validate(payload.get('timeline'))
            with self.server.lock:
                current = self.server.read_project()
                if payload.get('revision') != current['revision']:
                    return self.reply(409, {'error': '其他人已修改，请先下载本机草稿，再加载最新版本', 'revision': current['revision']})
                restored_from = payload.get('restoreRevision')
                if restored_from is not None:
                    if not isinstance(restored_from, str):
                        raise ValueError('恢复版本无效')
                    try:
                        timeline = self.server.history_record(restored_from)['timeline']
                    except FileNotFoundError:
                        return self.reply(404, {'error': '要恢复的版本不存在'})
                else:
                    timeline = payload['timeline']
                if current['timeline'] == timeline and restored_from is None:
                    return self.reply(200, {k:v for k,v in current.items() if k != 'timeline'})
                if current['timeline'] is not None:
                    backup = self.server.state_dir / 'backups' / (current['revision'] + '.json')
                    if not backup.exists():
                        atomic_write(backup, encoded(current))
                result = {'revision': uuid.uuid4().hex, 'timeline': timeline,
                          'updatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds'),
                          'updatedBy': editor, 'summary': '恢复历史版本' if restored_from else change_summary(current['timeline'], timeline),
                          'restoredFrom': restored_from}
                atomic_write(self.server.state_dir / 'timeline.json', encoded(result))
            self.reply(200, {k:v for k,v in result.items() if k != 'timeline'})
        except (ValueError, TypeError, KeyError) as error:
            self.reply(400, {'error': str(error)})
        except OSError:
            self.log_error('Cannot save timeline state')
            self.reply(500, {'error': '服务器保存失败，请保留本机草稿后重试'})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--web-root', type=Path, required=True)
    parser.add_argument('--state-dir', type=Path, required=True)
    args = parser.parse_args()
    server = TimelineServer((args.host, args.port), args.web_root, args.state_dir)
    print(f'Timeline listening on http://{args.host}:{args.port}', flush=True)
    server.serve_forever()
