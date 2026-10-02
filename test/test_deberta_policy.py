import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'privacy_policy', Path(__file__).parents[1] / 'classifier/privacy_policy.py'
)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


def clear_scores():
    scores = dict.fromkeys(policy.HYPOTHESES, 0.0)
    scores['non_sensitive_content'] = 0.99
    return scores


class LocalPrivacyPolicyTest(unittest.TestCase):
    def test_structured_secrets_block_despite_model_allowance(self):
        examples = [
            'Log in: https://auth.example/login?access_token=secret123',
            'Your sign-in code is 739104',
            'Your password: SecretPhrase889',
        ]
        for text in examples:
            with self.subTest(text=text):
                self.assertEqual(policy.decision(clear_scores(), text), 'deny')

    def test_generic_advice_and_ordinary_prices_are_not_secrets(self):
        examples = [
            'Never share a password with anyone.',
            'A general medical consultation costs $90.',
            'Use a password manager and two-factor authentication.',
        ]
        for text in examples:
            with self.subTest(text=text):
                self.assertEqual(policy.decision(clear_scores(), text), 'allow')

    def test_medication_score_and_invalid_scores_withhold(self):
        scores = clear_scores()
        scores['personal_medication'] = 0.11
        self.assertEqual(policy.decision(scores, 'Take the prescription'), 'deny')
        del scores['personal_medication']
        self.assertEqual(policy.decision(scores, 'ordinary'), 'uncertain')


if __name__ == '__main__':
    unittest.main()
