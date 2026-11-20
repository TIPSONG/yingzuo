"""Preserve a small, immutable deployment baseline without importing ComfyUI.

Only explicitly selected files and Git metadata/code diffs are collected. Model
weights, repository remotes, environment variables and credential files are not.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_DIFF_BYTES = 2 * 1024 * 1024
TEXT_SUFFIXES = {'.py', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.css',
                 '.html', '.md', '.txt', '.toml', '.yaml', '.yml', '.json',
                 '.bat', '.cmd', '.ps1', '.sh', '.ini', '.cfg'}
SENSITIVE_NAME = re.compile(r'(^|[/_.-])(credentials?|secrets?|tokens?|auth|apikey|api_key|passwords?)([/_.-]|$)', re.I)
SECRET_VALUE = re.compile(r'(?i)((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*[\"\']?)([^\s\"\',;}]+)')
KNOWN_TOKEN = re.compile(r'\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+|hf_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9_-]{16,})\b')


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def selected_files(comfy_root: Path) -> list[tuple[Path, Path]]:
    """Only collect the requested deployment artifacts, never walk model dirs."""
    selected = []
    for file in sorted((comfy_root / 'user/default/workflows').glob('*.json')):
        selected.append((file, Path('files/ComfyUI') / file.relative_to(comfy_root)))
    launchers = {*comfy_root.glob('Start*.bat'), *comfy_root.glob('Stop*.bat')}
    for file in sorted(launchers):
        selected.append((file, Path('files/ComfyUI') / file.name))
    for relative in ('Gemma提示词润色说明.md',
                     'custom_nodes/comfyui-lmstudio-prompt-enhancer/lmstudio_prompt_enhancer.py',
                     'custom_nodes/comfyui-lmstudio-prompt-enhancer/__init__.py'):
        selected.append((comfy_root / relative, Path('files/ComfyUI') / relative))
    patch = comfy_root.parent / 'qwen-deployment/lmstudio-local.patch'
    selected.append((patch, Path('files/qwen-deployment/lmstudio-local.patch')))
    return selected


def git_read(repo: Path, *args: str) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env['GIT_OPTIONAL_LOCKS'] = '0'
    return subprocess.run(
        ['git', '--no-optional-locks', '-c', 'core.quotepath=false',
         '-c', 'core.fsmonitor=false', '-C', str(repo), *args],
        capture_output=True, timeout=30, env=env, check=False)


def safe_diff_path(name: str) -> bool:
    path = PurePosixPath(name)
    return (not path.is_absolute() and '..' not in path.parts
            and path.suffix.lower() in TEXT_SUFFIXES
            and not any(part.lower() in {'models', '.git', 'node_modules', '.env'} for part in path.parts)
            and not path.name.lower().startswith('.env')
            and not SENSITIVE_NAME.search(name))


def redact(text: str) -> tuple[str, int]:
    text, assignments = SECRET_VALUE.subn(r'\1[REDACTED]', text)
    text, tokens = KNOWN_TOKEN.subn('[REDACTED]', text)
    return text, assignments + tokens


def write_new(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as stream:
        stream.write(payload)


def repository_snapshot(repo: Path, label: str, output: Path) -> dict:
    result = {'name': label, 'path': str(repo), 'available': False}
    try:
        top = git_read(repo, 'rev-parse', '--show-toplevel')
        if top.returncode or Path(top.stdout.decode('utf-8', 'replace').strip()).resolve() != repo.resolve():
            result['reason'] = 'Directory is not the root of a Git repository.'
            return result
        head = git_read(repo, 'rev-parse', 'HEAD')
        status = git_read(repo, 'status', '--porcelain=v1', '--untracked-files=normal')
        if head.returncode or status.returncode:
            raise RuntimeError('Unable to read repository HEAD/status.')
        result.update(available=True, head=head.stdout.decode().strip())
        status_path = Path('repos') / label / 'status.txt'
        write_new(output / status_path, status.stdout)
        result['status_file'] = status_path.as_posix()
        result['diffs'] = []
        for kind, flags in (('unstaged', []), ('staged', ['--cached'])):
            changed = git_read(repo, 'diff', *flags, '--name-only', '-z', '--no-ext-diff', '--no-textconv')
            if changed.returncode:
                raise RuntimeError('Unable to list changed paths.')
            chunks, excluded, redactions = [], [], 0
            for name_bytes in changed.stdout.split(b'\0'):
                if not name_bytes:
                    continue
                name = name_bytes.decode('utf-8', 'replace')
                current = repo / name
                if (not safe_diff_path(name) or current.is_symlink()
                        or (current.exists() and current.stat().st_size > MAX_DIFF_BYTES)):
                    excluded.append({'path': name, 'reason': 'Not an eligible small source/document file.'})
                    continue
                diff = git_read(repo, 'diff', *flags, '--no-ext-diff', '--no-textconv', '--', name)
                if diff.returncode or len(diff.stdout) > MAX_DIFF_BYTES or b'\0' in diff.stdout:
                    excluded.append({'path': name, 'reason': 'Unreadable, binary or oversized diff.'})
                    continue
                cleaned, count = redact(diff.stdout.decode('utf-8', 'replace'))
                chunks.append(cleaned)
                redactions += count
            diff_path = Path('repos') / label / f'{kind}.patch'
            write_new(output / diff_path, ''.join(chunks).encode('utf-8'))
            result['diffs'].append({'kind': kind, 'file': diff_path.as_posix(),
                                    'redacted_values': redactions, 'excluded': excluded})
    except (OSError, subprocess.TimeoutExpired, RuntimeError) as error:
        result['available'] = False
        result['reason'] = str(error)
    return result


def create_baseline(comfy_root: Path, output: Path) -> tuple[dict, bool]:
    comfy_root = comfy_root.resolve()
    output = output.resolve()
    if not comfy_root.is_dir():
        raise ValueError(f'ComfyUI directory does not exist: {comfy_root}')
    if output == comfy_root or comfy_root in output.parents:
        raise ValueError('Baseline output must be outside the ComfyUI installation.')
    manifest_path = output / 'manifest.json'
    if output.exists():
        if manifest_path.is_file():
            return json.loads(manifest_path.read_text(encoding='utf-8')), False
        raise ValueError(f'Output already exists without a complete manifest; not overwriting: {output}')

    candidates, missing = [], []
    for source, relative in selected_files(comfy_root):
        if not source.is_file():
            missing.append(str(source))
            continue
        if source.is_symlink() or source.stat().st_size > MAX_FILE_BYTES:
            raise ValueError(f'Refusing a linked or oversized protected file: {source}')
        # Reject directory junctions/symlinked ancestors escaping the selected root.
        allowed_root = comfy_root.parent / 'qwen-deployment' if relative.parts[1] == 'qwen-deployment' else comfy_root
        if not source.resolve().is_relative_to(allowed_root.resolve()):
            raise ValueError(f'Protected file escapes its expected directory: {source}')
        candidates.append((source, relative))

    output.mkdir(parents=True, exist_ok=False)
    manifest = {'schema_version': 1,
                'created_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                'comfy_root': str(comfy_root), 'files': [], 'missing_files': missing,
                'notes': ['Only selected deployment files are copied; no model weights, Git remotes or credential stores.',
                          'Git diffs exclude credential-like paths/large files and redact recognizable credential assignments.',
                          'Untracked files are listed by Git status; only explicitly selected artifacts are copied.']}
    for source, relative in candidates:
        content = source.read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        write_new(output / relative, content)
        manifest['files'].append({'source': str(source), 'backup': relative.as_posix(),
                                  'bytes': len(content), 'sha256': digest})
    repos = [('ComfyUI', comfy_root),
             ('ComfyUI-GGUF', comfy_root / 'custom_nodes/ComfyUI-GGUF'),
             ('Gemma', comfy_root / 'custom_nodes/comfyui-lmstudio-prompt-enhancer')]
    manifest['repositories'] = [repository_snapshot(path, name, output) for name, path in repos]
    write_new(manifest_path, (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    return manifest, True


def verify_baseline(output: Path) -> dict:
    output = output.resolve()
    manifest = json.loads((output / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('schema_version') != 1:
        raise ValueError('Unsupported baseline manifest version.')
    problems = []
    for record in manifest['files']:
        backup = (output / record['backup']).resolve()
        if not backup.is_relative_to(output):
            raise ValueError('Backup path escapes the baseline directory.')
        for kind, path in (('source', Path(record['source'])), ('backup', backup)):
            try:
                digest = sha256_file(path)
                if digest != record['sha256']:
                    problems.append({'kind': kind, 'path': str(path), 'state': 'changed'})
            except (FileNotFoundError, IsADirectoryError):
                problems.append({'kind': kind, 'path': str(path), 'state': 'missing'})
            except OSError:
                problems.append({'kind': kind, 'path': str(path), 'state': 'unreadable'})
    # A file absent at capture time remains a known gap, never silently protected.
    return {'ok': not problems, 'checked_files': len(manifest['files']),
            'problems': problems, 'missing_at_capture': manifest.get('missing_files', [])}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--comfy-root', type=Path, default=Path('D:/agent/ComfyUI'))
    parser.add_argument('--output', type=Path, default=PROJECT_ROOT / '.local/p0-baseline')
    parser.add_argument('--verify', action='store_true', help='Compare protected sources and backup copies to manifest SHA256 values.')
    args = parser.parse_args(argv)
    try:
        if args.verify:
            result = verify_baseline(args.output)
            print(f"Verification: {'PASS' if result['ok'] else 'FAIL'}; {result['checked_files']} protected files.")
            for item in result['problems']:
                print(f"  {item['kind']} {item['state']}: {item['path']}")
            if result['missing_at_capture']:
                print(f"  Note: {len(result['missing_at_capture'])} selected files were absent at capture time.")
            return 0 if result['ok'] else 1
        manifest, created = create_baseline(args.comfy_root, args.output)
        print('Baseline created.' if created else 'Existing baseline retained; no files overwritten. Use --verify to check current sources.')
        print(f"Location: {args.output.resolve()}")
        print(f"Protected files: {len(manifest['files'])}; missing selected files: {len(manifest['missing_files'])}.")
        for repo in manifest['repositories']:
            print(f"  {repo['name']}: {repo.get('head', 'unavailable')}" + ('' if repo['available'] else ' (metadata incomplete)'))
        return 0
    except (OSError, ValueError, KeyError) as error:
        print(f'Baseline error: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
