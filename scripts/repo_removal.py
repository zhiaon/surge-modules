"""Only prune a vanished source when repo API and original module URL both 404.
A missing branch, 403, rate limit, timeout or server error must not delete data.
404 means unavailable to this index (possibly private), not proven deletion.
"""
import urllib.request
import urllib.error
import urllib.parse


def confirmed_missing_repo(owner, repo, gh):
    try:
        gh(f'https://api.github.com/repos/{owner}/{repo}')
    except urllib.error.HTTPError as e:
        return e.code == 404
    except Exception:
        return False
    return False


def missing_public_module(owner, repo, branch, path):
    encoded = '/'.join(urllib.parse.quote(p, safe='') for p in path.split('/'))
    ref = urllib.parse.quote(branch, safe='')
    url = f'https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{encoded}'
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'surge-modules-sync'})
        with urllib.request.urlopen(req, timeout=20):
            return False
    except urllib.error.HTTPError as e:
        return e.code == 404
    except Exception:
        return False
