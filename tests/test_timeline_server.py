import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from deploy.timeline_server import TimelineServer

ROOT = Path(__file__).resolve().parents[1]
PROJECT = {'title': '共享测试', 'months': [{'year':2026,'month':10,'width':300}], 'view':{'w':800,'h':1020}, 'lanes':[{'id':'l','name':'研发','y':400}], 'nodes':[{'id':'n','x':300,'y':400}], 'texts':[], 'arrows':[]}

class SharedTimelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.server = TimelineServer(('127.0.0.1',0), ROOT/'static', self.temp.name)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:'+str(self.server.server_port)
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join();self.temp.cleanup()
    def request(self, path='/api/timeline', payload=None, headers=None):
        if payload is not None:
            payload = {'editor':'测试编辑人', **payload}
        request = Request(self.url+path, data=json.dumps(payload).encode() if payload is not None else None, method='PUT' if payload is not None else 'GET', headers=headers or {'Content-Type':'application/json'})
        try: response = urlopen(request, timeout=3)
        except HTTPError as error: response = error
        with response:
            body = response.read()
            return response.status, json.loads(body) if 'application/json' in response.headers.get('Content-Type','') else body.decode()
    def test_persistence_conflict_and_backup(self):
        self.assertEqual(self.request()[1]['revision'],'empty')
        first=self.request(payload={'revision':'empty','timeline':PROJECT})[1]
        changed=copy.deepcopy(PROJECT);changed['title']='同事 A 的修改'
        self.assertEqual(self.request(payload={'revision':first['revision'],'timeline':changed})[0],200)
        self.assertEqual(self.request(payload={'revision':first['revision'],'timeline':PROJECT})[0],409)
        self.assertEqual(self.request()[1]['timeline']['title'],changed['title'])
        backups=list((Path(self.temp.name)/'backups').glob('*.json'))
        self.assertEqual(len(backups),1)
        self.assertEqual(json.loads(backups[0].read_text())['timeline'],PROJECT)
        fresh=TimelineServer(('127.0.0.1',0),ROOT/'static',self.temp.name)
        self.addCleanup(fresh.server_close)
        self.assertEqual(fresh.read_project()['timeline'],changed)
    def test_only_timeline_routes_are_exposed(self):
        status,html=self.request('/')
        self.assertEqual(status,200);self.assertIn('id="timelineServerConfig"',html)
        for path in ('/api/projects','/roadmap','/.git/config','/data/timeline.json','/../app.py'):
            self.assertEqual(self.request(path)[0],404,path)
        self.assertEqual(self.request('/save-queue.js')[0],200)
    def test_invalid_and_cross_origin_writes_do_not_change_saved_project(self):
        self.request(payload={'revision':'empty','timeline':PROJECT})
        revision=self.request()[1]['revision']
        self.assertEqual(self.request(payload={'revision':revision,'timeline':{} })[0],400)
        self.assertEqual(self.request(payload={'revision':revision,'timeline':PROJECT},headers={'Content-Type':'application/json','Origin':'http://unrelated.example'})[0],403)
        self.assertEqual(self.request()[1]['revision'],revision)
    def test_parallel_writers_only_one_succeeds(self):
        self.request(payload={'revision':'empty','timeline':PROJECT})
        revision=self.request()[1]['revision'];results=[]
        def write(title):
            project=copy.deepcopy(PROJECT);project['title']=title
            results.append(self.request(payload={'revision':revision,'timeline':project})[0])
        threads=[threading.Thread(target=write,args=(title,)) for title in ('A','B')]
        for thread in threads:thread.start()
        for thread in threads:thread.join()
        self.assertEqual(sorted(results),[200,409])

    def test_history_records_authors_and_restore_creates_new_revision(self):
        first=self.request(payload={'revision':'empty','timeline':PROJECT,'editor':'张三'})[1]
        changed=copy.deepcopy(PROJECT);changed['title']='新的名称'
        second=self.request(payload={'revision':first['revision'],'timeline':changed,'editor':'李四'})[1]
        history=self.request('/api/history')[1]['versions']
        self.assertEqual({r['updatedBy'] for r in history},{'张三','李四'})
        self.assertTrue(all(r['updatedAt'] for r in history))
        self.assertNotIn('timeline',history[0])
        self.assertEqual(self.request('/api/history/'+first['revision'])[1]['timeline'],PROJECT)
        restored=self.request(payload={'revision':second['revision'],'restoreRevision':first['revision'],'editor':'王五'})[1]
        self.assertEqual(restored['updatedBy'],'王五')
        self.assertEqual(restored['restoredFrom'],first['revision'])
        self.assertNotEqual(restored['revision'],first['revision'])
        self.assertEqual(self.request()[1]['timeline'],PROJECT)
        self.assertEqual(len(self.request('/api/history')[1]['versions']),3)
        self.assertEqual(self.request('/api/history/'+second['revision'])[1]['timeline'],changed)
        self.assertEqual(self.request(payload={'revision':second['revision'],'restoreRevision':first['revision'],'editor':'王五'})[0],409)
    def test_name_required_and_duplicate_saves_do_not_make_new_history(self):
        self.assertEqual(self.request(payload={'revision':'empty','timeline':PROJECT,'editor':''})[0],400)
        first=self.request(payload={'revision':'empty','timeline':PROJECT})[1]
        second=self.request(payload={'revision':first['revision'],'timeline':PROJECT})[1]
        self.assertEqual(first['revision'],second['revision'])
        self.assertEqual(len(self.request('/api/history')[1]['versions']),1)
