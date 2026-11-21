"""Whole-source refusal: a blocked repo disappears and cannot come back."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import sync_upstream as su


class DenylistLoadingTests(unittest.TestCase):
    def test_repos_are_parsed_case_insensitively(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'denylist.json'
            path.write_text(json.dumps({'keys': ['a/b@main:x.sgmodule'],
                                        'name_patterns': [],
                                        'repos': ['Owner/Repo']}))
            with patch.object(su, 'DENYLIST', str(path)):
                keys, rx, repos = su.load_denylist()
        self.assertEqual(keys, {'a/b@main:x.sgmodule'})
        self.assertIsNone(rx)
        self.assertEqual(repos, {'owner/repo'})

    def test_old_file_without_repos_still_loads(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'denylist.json'
            path.write_text(json.dumps({'keys': [], 'name_patterns': ['bad']}))
            with patch.object(su, 'DENYLIST', str(path)):
                _, rx, repos = su.load_denylist()
        self.assertEqual(repos, set())
        self.assertIsNotNone(rx)

    def test_missing_file_is_permissive_but_safe(self):
        with patch.object(su, 'DENYLIST', '/nonexistent/denylist.json'):
            self.assertEqual(su.load_denylist(), (set(), None, set()))


class RecordDecisionTests(unittest.TestCase):
    rec = {'repo': 'Owner/Repo', 'branch': 'main', 'path': 'A.sgmodule'}

    def decide(self, keys=(), repos=()):
        with patch.object(su, 'DENY_KEYS', set(keys)), \
                patch.object(su, 'DENY_REPOS', {r.lower() for r in repos}):
            return su.denied_record(self.rec)

    def test_repo_block_matches_any_file_including_renames(self):
        self.assertTrue(self.decide(repos=['owner/repo']))
        self.assertTrue(self.decide(repos=['OWNER/REPO']))

    def test_exact_key_block_still_works(self):
        # Key entries stay strict and case-sensitive; only repo entries fold case.
        self.assertTrue(self.decide(keys=['Owner/Repo@main:A.sgmodule']))
        self.assertFalse(self.decide(keys=['Owner/Repo@main:B.sgmodule']))
        self.assertFalse(self.decide(keys=['owner/repo@main:A.sgmodule']))

    def test_other_repos_and_other_branches_are_untouched(self):
        self.assertFalse(self.decide(repos=['other/repo']))
        allowed = dict(self.rec, branch='dev')
        with patch.object(su, 'DENY_KEYS', set()), patch.object(su, 'DENY_REPOS', set()):
            self.assertFalse(su.denied_record(allowed))


class SourceRemovalIntegrationTests(unittest.TestCase):
    BLOCKED = 'xchun5678/surge'

    def state(self, directory):
        root = Path(directory)
        raw = root / 'raw'
        raw.mkdir()
        catalogue = {
            'blocked-one': {'slug': 'blocked-one', 'repo': self.BLOCKED, 'branch': 'main',
                            'path': 'One.sgmodule', 'sha': 's1', 'name': 'one', 'version': '1.0'},
            'blocked-rename': {'slug': 'blocked-rename', 'repo': self.BLOCKED, 'branch': 'main',
                               'path': 'Two.sgmodule', 'sha': 's2', 'name': 'two', 'version': '1.0'},
            'kept': {'slug': 'kept', 'repo': 'zhiaon/Modules', 'branch': 'main',
                     'path': 'kept.sgmodule', 'sha': 's3', 'name': 'kept', 'version': '1.0'},
        }
        for slug in catalogue:
            (raw / f'{slug}.sgmodule').write_text(f'#!name={slug}\n[Rule]\n')
        (root / 'catalogue.json').write_text(json.dumps(catalogue))
        (root / 'history.json').write_text('{}')
        sources = {'zhiaon/Modules@main': {'owner': 'zhiaon', 'repo': 'Modules',
                                           'branch': 'main'}}
        (root / 'sources.json').write_text(json.dumps(sources))
        return root, raw

    def run_sync(self, root, raw, dry_run=False):
        report_path = Path(root) / 'report.json'
        overrides = {'STATE': str(root), 'CATALOGUE': str(Path(root) / 'catalogue.json'),
                     'HISTORY': str(Path(root) / 'history.json'),
                     'SOURCES': str(Path(root) / 'sources.json'),
                     'RELEASES': str(Path(root) / 'none.json'),
                     'RAW_DIR': str(raw), 'REPORT': str(report_path),
                     'DENY_KEYS': set(), 'DENY_RX': None,
                     'DENY_REPOS': {self.BLOCKED}}
        with contextlib.ExitStack() as stack:
            for name, value in overrides.items():
                stack.enter_context(patch.object(su, name, value))
            stack.enter_context(patch.object(sys, 'argv',
                                             ['sync'] + (['--dry-run'] if dry_run else [])))
            fetch = stack.enter_context(patch.object(
                su, 'tree_snapshot', return_value={
                    'files': [{'path': 'kept.sgmodule', 'sha': 's3'}],
                    'sha': 'tree-kept', 'truncated': False}))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            self.assertEqual(su.main(), 0)
            # Only the healthy source is scanned; the blocked one never is.
            self.assertEqual({call.args[:2] for call in fetch.call_args_list},
                             {('zhiaon', 'Modules')})
        return json.loads(report_path.read_text())

    def test_blocked_repo_is_dropped_and_healthy_repo_kept(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, raw = self.state(tmp)
            report = self.run_sync(root, raw)
            catalogue = json.loads((root / 'catalogue.json').read_text())
            history = json.loads((root / 'history.json').read_text())
        self.assertEqual(set(catalogue), {'kept'})
        self.assertEqual(sorted(x['slug'] for x in report['removed']),
                         ['blocked-one', 'blocked-rename'])
        self.assertEqual(report['errors'], [])
        self.assertEqual(report['before'], 3)
        self.assertEqual(report['after'], 1)
        self.assertEqual(history['blocked-one'][-1]['type'], 'removed')

    def test_blocked_raw_files_are_deleted_but_kept_module_survives(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, raw = self.state(tmp)
            self.run_sync(root, raw)
            names = sorted(p.name for p in raw.iterdir())
        self.assertEqual(names, ['kept.sgmodule'])

    def test_dry_run_changes_nothing_on_disk(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, raw = self.state(tmp)
            before = {p.name: p.read_bytes() for p in raw.iterdir()}
            catalogue_before = (root / 'catalogue.json').read_bytes()
            report = self.run_sync(root, raw, dry_run=True)
            after = {p.name: p.read_bytes() for p in raw.iterdir()}
            catalogue_after = (root / 'catalogue.json').read_bytes()
        self.assertEqual(before, after)
        self.assertEqual(catalogue_before, catalogue_after)
        self.assertEqual(len(report['removed']), 2)

    def test_second_run_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, raw = self.state(tmp)
            self.run_sync(root, raw)
            again = self.run_sync(root, raw)
        self.assertEqual(again['removed'], [])
        self.assertEqual(again['errors'], [])


if __name__ == '__main__':
    unittest.main()
