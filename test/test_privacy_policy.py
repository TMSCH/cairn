import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('privacy_eval', Path(__file__).parents[1] / 'evaluation/evaluate.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class PrivacyPolicyTest(unittest.TestCase):
    def test_sensitive_evidence_overrides_ordinary_label(self):
        scores = dict.fromkeys(module.LABELS, 0.0)
        scores['non_sensitive_content'] = 0.99
        scores['private_medical_information'] = 0.2
        self.assertEqual(module.decide(scores), 'deny')

    def test_allow_requires_complete_finite_scores_and_confidence(self):
        scores = dict.fromkeys(module.LABELS, 0.0)
        self.assertEqual(module.decide(scores), 'uncertain')
        scores['non_sensitive_content'] = 0.99
        self.assertEqual(module.decide(scores), 'allow')
        scores['authentication_secret'] = float('nan')
        self.assertEqual(module.decide(scores), 'uncertain')
        del scores['authentication_secret']
        self.assertEqual(module.decide(scores), 'uncertain')
