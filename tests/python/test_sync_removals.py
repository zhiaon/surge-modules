"""Network-free regression coverage for the upstream removal safety gate."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import sync_upstream as su
import repo_removal as rr


def snapshot(count=14, sha='tree-one', truncated=False):
    return {'files': [{'path': f'Module-{i}.sgmodule', 'sha': f'blob-{i}'}
                      for i in range(count)], 'sha': sha, 'truncated': truncated}


def records(count=55):
    return {f'Module-{i}.sgmodule': (f'module-{i}', f'blob-{i}')
            for i in range(count)}


class TreeMetadataTests(unittest.TestCase):
    def response(self, **kwargs):
        return {'sha': 'tree-one', 'truncated': False, 'tree': [
            {'path': 'Module.sgmodule', 'type': 'blob', 'sha': 'b1'},
            {'path': 'nested/Mixed.SGMODULE', 'type': 'blob', 'sha': 'b2'},
            {'path': '.hidden.sgmodule', 'type': 'blob', 'sha': 'b3'},
            {'path': 'README.sgmodule', 'type': 'blob', 'sha': 'b4'},
            {'path': 'not-a-module.txt', 'type': 'blob', 'sha': 'b5'},
            {'path': 'folder.sgmodule', 'type': 'tree', 'sha': 'b6'},
        ], **kwargs}

    def test_metadata_and_filtering_preserved(self):
        with patch.object(su, 'gh', return_value=self.response()):
            result = su.tree_snapshot('owner', 'repo', 'main')
        self.assertFalse(result['truncated'])
        self.assertEqual(result['sha'], 'tree-one')
        self.assertEqual([x['path'] for x in result['files']],
                         ['Module.sgmodule', 'nested/Mixed.SGMODULE'])

    def test_truncated_flag_preserved(self):
        with patch.object(su, 'gh', return_value=self.response(truncated=True)):
            self.assertTrue(su.tree_snapshot('o', 'r', 'main')['truncated'])

    def test_missing_completeness_is_not_false(self):
        data = self.response()
        del data['truncated']
        with patch.object(su, 'gh', return_value=data):
            self.assertIsNone(su.tree_snapshot('o', 'r', 'main')['truncated'])

    def test_tree_of_still_returns_list_for_rebuild(self):
        with patch.object(su, 'gh', return_value=self.response()):
            self.assertIsInstance(su.tree_of('o', 'r', 'main'), list)

    def test_branch_is_url_encoded(self):
        with patch.object(su, 'gh', return_value=self.response()) as gh:
            su.tree_snapshot('o', 'r', 'feature/new branch')
        self.assertIn('/feature%2Fnew%20branch?recursive=1', gh.call_args.args[0])


class RemovalPlanTests(unittest.TestCase):
    def plan(self, tree=None, old=None):
        return su.plan_removals('owner', 'repo', 'main',
                                records() if old is None else old,
                                snapshot() if tree is None else tree)

    def test_empty_tree_still_blocks(self):
        gone, reason = self.plan(snapshot(0))
        self.assertEqual(gone, [])
        self.assertIn('空文件列表', reason)

    def test_truncated_tree_blocks_even_a_small_loss(self):
        gone, reason = self.plan(snapshot(54, truncated=True))
        self.assertEqual(gone, [])
        self.assertIn('不完整', reason)

    def test_missing_completeness_marker_blocks(self):
        tree = snapshot()
        del tree['truncated']
        self.assertIn('完整性', self.plan(tree)[1])

    def test_small_loss_needs_no_extra_requests(self):
        with patch.object(su, 'missing_public_module') as probe, \
                patch.object(su, 'tree_snapshot') as fetch:
            gone, reason = self.plan(snapshot(54))
        self.assertEqual(gone, ['Module-54.sgmodule'])
        self.assertIsNone(reason)
        probe.assert_not_called()
        fetch.assert_not_called()

    def test_threshold_boundary_20_still_normal(self):
        with patch.object(su, 'missing_public_module') as probe:
            gone, reason = self.plan(snapshot(21), records(41))
        self.assertEqual(len(gone), 20)
        self.assertIsNone(reason)
        probe.assert_not_called()

    def test_large_loss_all_404_and_stable_complete_tree(self):
        with patch.object(su, 'missing_public_module', return_value=True) as probe, \
                patch.object(su, 'tree_snapshot', return_value=snapshot()) as fetch:
            gone, reason = self.plan()
        self.assertEqual(len(gone), 41)
        self.assertIsNone(reason)
        self.assertEqual(probe.call_count, 41)
        fetch.assert_called_once_with('owner', 'repo', 'main')

    def test_one_reachable_or_unconfirmed_file_blocks_whole_batch(self):
        with patch.object(su, 'missing_public_module', side_effect=[True, False]), \
                patch.object(su, 'tree_snapshot') as fetch:
            gone, reason = self.plan()
        self.assertEqual(gone, [])
        self.assertIn('Module-15.sgmodule', reason)
        self.assertIn('未确认404', reason)
        fetch.assert_not_called()

    def test_missing_tree_identity_blocks_before_probes(self):
        with patch.object(su, 'missing_public_module') as probe:
            gone, reason = self.plan(snapshot(sha=None))
        self.assertEqual(gone, [])
        self.assertIn('文件树标识', reason)
        probe.assert_not_called()

    def test_second_tree_exception_blocks(self):
        with patch.object(su, 'missing_public_module', return_value=True), \
                patch.object(su, 'tree_snapshot', side_effect=TimeoutError):
            self.assertIn('复查请求失败', self.plan()[1])

    def test_second_tree_truncated_blocks(self):
        with patch.object(su, 'missing_public_module', return_value=True), \
                patch.object(su, 'tree_snapshot', return_value=snapshot(truncated=True)):
            self.assertIn('复查文件树为空或不完整', self.plan()[1])

    def test_second_tree_empty_blocks(self):
        with patch.object(su, 'missing_public_module', return_value=True), \
                patch.object(su, 'tree_snapshot', return_value=snapshot(0)):
            self.assertIn('复查文件树为空或不完整', self.plan()[1])

    def test_second_tree_changed_identity_blocks(self):
        with patch.object(su, 'missing_public_module', return_value=True), \
                patch.object(su, 'tree_snapshot', return_value=snapshot(sha='tree-two')):
            self.assertIn('发生变化', self.plan()[1])

    def test_second_tree_changed_paths_even_with_same_identity_blocks(self):
        check = snapshot()
        check['files'][0]['path'] = 'Unexpected.sgmodule'
        with patch.object(su, 'missing_public_module', return_value=True), \
                patch.object(su, 'tree_snapshot', return_value=check):
            self.assertIn('发生变化', self.plan()[1])

    def test_tree_order_does_not_matter(self):
        check = snapshot()
        check['files'].reverse()
        with patch.object(su, 'missing_public_module', return_value=True), \
                patch.object(su, 'tree_snapshot', return_value=check):
            self.assertIsNone(self.plan()[1])

    def test_empty_new_source_is_safe(self):
        self.assertEqual(self.plan(snapshot(0), {}), ([], None))


class Public404Tests(unittest.TestCase):
    def test_only_404_confirms_absence(self):
        for status in (401, 403, 404, 429, 500, 502, 503):
            with self.subTest(status=status), \
                    patch.object(rr.urllib.request, 'urlopen',
                                 side_effect=HTTPError('url', status, 'error', {}, None)):
                self.assertEqual(rr.missing_public_module('o', 'r', 'main', 'x'),
                                 status == 404)

    def test_200_does_not_confirm_absence(self):
        with patch.object(rr.urllib.request, 'urlopen'):
            self.assertFalse(rr.missing_public_module('o', 'r', 'main', 'x'))

    def test_timeout_and_network_error_do_not_confirm_absence(self):
        for error in (TimeoutError(), URLError('network')):
            with self.subTest(error=type(error).__name__), \
                    patch.object(rr.urllib.request, 'urlopen', side_effect=error):
                self.assertFalse(rr.missing_public_module('o', 'r', 'main', 'x'))

    def test_unicode_spaces_and_branch_are_encoded(self):
        with patch.object(rr.urllib.request, 'urlopen') as fetch:
            rr.missing_public_module('o', 'r', 'feature/test', '目录/a b.sgmodule')
        url = fetch.call_args.args[0].full_url
        self.assertIn('feature%2Ftest/', url)
        self.assertIn('%E7%9B%AE%E5%BD%95/a%20b.sgmodule', url)

    def test_source_repo_404_still_requires_explicit_repo_404(self):
        for status in (403, 404, 429, 500):
            with self.subTest(status=status):
                probe = lambda url: (_ for _ in ()).throw(
                    HTTPError(url, status, 'error', {}, None))
                self.assertEqual(rr.confirmed_missing_repo('o', 'r', probe), status == 404)


class SyncIntegrationTests(unittest.TestCase):
    def run_sync(self, mode='confirmed', dry_run=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = root / 'raw'
            raw.mkdir()
            catalogue = {
                slug: {'slug': slug, 'repo': 'owner/repo', 'branch': 'main',
                       'path': path, 'sha': sha, 'name': slug, 'version': '1.0'}
                for path, (slug, sha) in records().items()}
            catalogue['unrelated'] = {'slug': 'unrelated', 'repo': 'other/repo',
                                      'branch': 'main', 'path': 'other.sgmodule',
                                      'sha': 'other-sha', 'name': 'unrelated'}
            for slug in catalogue:
                (raw / f'{slug}.sgmodule').write_text(f'original {slug}')
            cat = root / 'catalogue.json'
            hist = root / 'history.json'
            sources = root / 'sources.json'
            cat.write_text(json.dumps(catalogue))
            hist.write_text('{}')
            source_data = {'owner/repo@main': {'owner': 'owner', 'repo': 'repo',
                                              'branch': 'main'}}
            sources.write_text(json.dumps(source_data))
            before = {str(p.relative_to(root)): p.read_bytes()
                      for p in root.rglob('*') if p.is_file()}
            first = snapshot()
            check = snapshot()
            if mode == 'empty':
                first = snapshot(0)
            elif mode == 'truncated':
                first['truncated'] = True
            elif mode == 'changed':
                check['sha'] = 'tree-two'
            elif mode == 'reachable':
                first['files'].append({'path': 'New.sgmodule', 'sha': 'new-sha'})
            report_path = root / 'report.json'
            with contextlib.ExitStack() as stack:
                overrides = {'STATE': str(root), 'CATALOGUE': str(cat),
                             'HISTORY': str(hist), 'SOURCES': str(sources),
                             'RELEASES': str(root / 'no-releases.json'),
                             'RAW_DIR': str(raw), 'REPORT': str(report_path),
                             'DENY_KEYS': set(), 'DENY_RX': None}
                for key, value in overrides.items():
                    stack.enter_context(patch.object(su, key, value))
                stack.enter_context(patch.object(sys, 'argv',
                                                 ['sync'] + (['--dry-run'] if dry_run else [])))
                stack.enter_context(patch.object(su, 'tree_snapshot',
                                                 side_effect=[first, check]))
                probe = stack.enter_context(patch.object(su, 'missing_public_module',
                                                          return_value=mode != 'reachable'))
                fetch = stack.enter_context(patch.object(su, 'raw_file'))
                stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                result = su.main()
                self.assertEqual(result, 0)
                fetch.assert_not_called()
            after = {str(p.relative_to(root)): p.read_bytes()
                     for p in root.rglob('*') if p.is_file() and p != report_path}
            return {'report': json.loads(report_path.read_text()),
                    'catalogue': json.loads(cat.read_text()),
                    'sources': json.loads(sources.read_text()),
                    'history': json.loads(hist.read_text()),
                    'before': before, 'after': after, 'probe_count': probe.call_count}

    def test_confirmed_removal_really_deletes_41_catalogue_and_raw_records(self):
        result = self.run_sync()
        self.assertEqual(len(result['catalogue']), 15)  # 14 kept + unrelated
        self.assertIn('unrelated', result['catalogue'])
        report = result['report']
        self.assertEqual(len(report['removed']), 41)
        self.assertEqual(report['errors'], [])
        self.assertEqual(report['confirmed_removals'][0]['count'], 41)
        self.assertEqual(report['after'], report['before'] - 41)
        self.assertEqual(len([p for p in result['after'] if p.startswith('raw/')]), 15)
        for item in report['removed']:
            self.assertEqual(result['history'][item['slug']][-1]['type'], 'removed')
            self.assertNotIn(f"raw/{item['slug']}.sgmodule", result['after'])
        for name, contents in result['after'].items():
            if name.startswith('raw/'):
                self.assertEqual(contents, result['before'][name])
        self.assertIn('owner/repo@main', result['sources'])

    def assert_kept(self, mode):
        result = self.run_sync(mode)
        self.assertEqual(result['catalogue'].keys(),
                         {f'module-{i}' for i in range(55)} | {'unrelated'})
        self.assertEqual(result['report']['removed'], [])
        self.assertEqual(len(result['report']['errors']), 1)
        self.assertEqual(result['history'], {})
        for name, contents in result['before'].items():
            if name.startswith('raw/') or name == 'sources.json':
                self.assertEqual(contents, result['after'][name])

    def test_empty_tree_retains_every_module_and_raw(self):
        self.assert_kept('empty')

    def test_truncated_tree_retains_every_module_and_raw(self):
        self.assert_kept('truncated')

    def test_one_200_retains_entire_repo_even_pending_import(self):
        self.assert_kept('reachable')

    def test_branch_changed_during_confirmation_retains_all(self):
        self.assert_kept('changed')

    def test_dry_run_reports_but_cannot_delete_or_write_persistent_state(self):
        result = self.run_sync(dry_run=True)
        self.assertEqual(result['before'], result['after'])
        self.assertEqual(len(result['report']['removed']), 41)
        self.assertEqual(result['report']['errors'], [])


if __name__ == '__main__':
    unittest.main()
