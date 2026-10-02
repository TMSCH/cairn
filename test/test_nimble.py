"""Exercise the real adapter with a synthetic local scorer, without GPU dependencies."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

class AdapterTest(unittest.TestCase):
    def test_decisions_threshold_and_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scorer = root / 'nimble/scoring'
            scorer.mkdir(parents=True)
            (scorer / 'parallel_scorer.py').write_text('''
import os
class ParallelScorer:
    def __init__(self, **kwargs):
        assert os.environ['HF_HUB_OFFLINE'] == '1'
        assert os.environ['TRANSFORMERS_OFFLINE'] == '1'
    def score(self, text, schema):
        print('library noise')
        if text == 'fail': raise ValueError('private data')
        return {'output': {'disclosure': 'deny' if text == 'medical record' else 'allow'},
                'fields': {'disclosure': {'scores': {'allow': 0.5 if text == 'ambiguous' else 0.999}}}}
''')
            config = root / 'model.json'
            config.write_text(json.dumps({'model_path': str(root)}))
            import os
            result = subprocess.run([sys.executable, str(Path(__file__).parents[1] / 'classifier/adapter.py'), str(config)],
                input=''.join(json.dumps({'text': t})+'\n' for t in ['appointment','medical record','ambiguous','fail','x'*48001]),
                text=True, capture_output=True, env={**os.environ, 'PYTHONPATH': str(root)}, check=True)
            self.assertEqual([json.loads(line)['decision'] for line in result.stdout.splitlines()],
                             ['allow','deny','uncertain','uncertain','uncertain'])
            self.assertNotIn('private data', result.stdout)

if __name__ == '__main__': unittest.main()
