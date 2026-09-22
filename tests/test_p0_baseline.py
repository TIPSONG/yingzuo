"""Exercise baseline preservation using temporary fake deployments only."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location('p0_baseline', Path(__file__).resolve().parents[1] / 'tools/p0_baseline.py')
baseline = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(baseline)


class BaselineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.comfy = self.root / 'ComfyUI'
        self.output = self.root / 'baseline'
        self.files = {}
        for index in range(5):
            self.write(f'user/default/workflows/workflow-{index}.json', json.dumps({'id': index}).encode())
        self.write('Start-ComfyUI.bat', b'@echo off\r\n')
        self.write('Start-ComfyUI-with-Gemma.bat', b'@echo Gemma\r\n')
        self.write('Stop-ComfyUI.bat', b'@echo stop\r\n')
        self.write('Gemma提示词润色说明.md', '部署说明'.encode())
        self.write('custom_nodes/comfyui-lmstudio-prompt-enhancer/lmstudio_prompt_enhancer.py', b'VALUE = 1\n')
        self.write('custom_nodes/comfyui-lmstudio-prompt-enhancer/__init__.py', b'# init\n')
        patch = self.root / 'qwen-deployment/lmstudio-local.patch'
        patch.parent.mkdir()
        patch.write_bytes(b'local patch\n')
        self.files[patch] = patch.read_bytes()
        self.write('models/diffusion_models/large.gguf', b'do not collect', protected=False)
        self.write('.env', b'PASSWORD=do-not-collect', protected=False)

    def write(self, relative, content, protected=True):
        path = self.comfy / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        if protected:
            self.files[path] = content
        return path

    def test_exact_selected_files_and_hashes(self):
        manifest, created = baseline.create_baseline(self.comfy, self.output)
        self.assertTrue(created)
        self.assertEqual(len(manifest['files']), 12)
        self.assertEqual(manifest['missing_files'], [])
        self.assertEqual({item['source'] for item in manifest['files']}, {str(path) for path in self.files})
        for item in manifest['files']:
            self.assertEqual((self.output / item['backup']).read_bytes(), self.files[Path(item['source'])])
        self.assertTrue(baseline.verify_baseline(self.output)['ok'])
        self.assertFalse(any(p.suffix == '.gguf' or p.name == '.env' for p in self.output.rglob('*')))

    def test_repeat_keeps_original_manifest_and_backup_after_source_change(self):
        first, _ = baseline.create_baseline(self.comfy, self.output)
        original_manifest = (self.output / 'manifest.json').read_bytes()
        source = self.comfy / 'Start-ComfyUI.bat'
        source.write_bytes(b'changed later\n')
        second, created = baseline.create_baseline(self.comfy, self.output)
        self.assertFalse(created)
        self.assertEqual(first, second)
        self.assertEqual((self.output / 'manifest.json').read_bytes(), original_manifest)
        self.assertEqual((self.output / 'files/ComfyUI/Start-ComfyUI.bat').read_bytes(), self.files[source])
        result = baseline.verify_baseline(self.output)
        self.assertFalse(result['ok'])
        self.assertEqual(result['problems'], [{'kind': 'source', 'path': str(source), 'state': 'changed'}])

    def test_identifies_missing_source_and_tampered_backup(self):
        baseline.create_baseline(self.comfy, self.output)
        (self.comfy / 'Stop-ComfyUI.bat').unlink()
        (self.output / 'files/ComfyUI/Start-ComfyUI.bat').write_bytes(b'tampered')
        result = baseline.verify_baseline(self.output)
        self.assertFalse(result['ok'])
        self.assertEqual({(p['kind'], p['state']) for p in result['problems']}, {('source', 'missing'), ('backup', 'changed')})

    def test_incomplete_existing_output_is_not_overwritten(self):
        self.output.mkdir()
        marker = self.output / 'marker.txt'
        marker.write_text('keep')
        with self.assertRaisesRegex(ValueError, 'not overwriting'):
            baseline.create_baseline(self.comfy, self.output)
        self.assertEqual(marker.read_text(), 'keep')
        self.assertFalse((self.output / 'manifest.json').exists())

    def test_output_cannot_modify_comfy_installation(self):
        with self.assertRaisesRegex(ValueError, 'outside'):
            baseline.create_baseline(self.comfy, self.comfy / 'baseline')

    def test_optional_missing_patch_is_reported(self):
        (self.root / 'qwen-deployment/lmstudio-local.patch').unlink()
        manifest, _ = baseline.create_baseline(self.comfy, self.output)
        self.assertEqual(len(manifest['files']), 11)
        self.assertEqual(len(manifest['missing_files']), 1)
        self.assertTrue(baseline.verify_baseline(self.output)['ok'])

    def test_diff_filter_and_credential_redaction(self):
        for path in ('.env', 'credentials.json', 'models/checkpoints/config.json', '../escape.py', 'model.gguf'):
            self.assertFalse(baseline.safe_diff_path(path), path)
        self.assertTrue(baseline.safe_diff_path('comfy/server.py'))
        text, count = baseline.redact('+api_key = "private-value"\n+"hf_abcdefghijklmnop"\n')
        self.assertEqual(count, 2)
        self.assertNotIn('private-value', text)
        self.assertNotIn('hf_abcdefghijklmnop', text)


if __name__ == '__main__':
    unittest.main()
