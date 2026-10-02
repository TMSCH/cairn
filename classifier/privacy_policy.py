"""Local disclosure policy shared by evaluation and the DeBERTa adapter.

This module never loads data or makes network requests. The model questions are
deliberately explicit so ordinary medical scheduling is not a private record.
"""

import math
import re

HYPOTHESES = {
    "non_sensitive_content": "This email contains no confidential personal information or authentication secrets.",
    "private_medical_information": "This email discloses personal clinical information such as a diagnosis, symptoms, medical test results, or treatment.",
    "personal_medication": "This email gives a specific person prescription medication instructions, a dose, or a change to their treatment.",
    "authentication_secret": "This email discloses an actual password, authentication code, private key or secret access token.",
    "private_financial_or_identity_information": "This email discloses personal bank account details, payment card numbers or government identification numbers.",
    "other_sensitive_content": "This email discloses intimate personal information or encoded confidential personal information.",
}

# High-specificity checks for structured authentication secrets. Semantic
# classification still handles secrets written in other forms. Patterns do not
# attempt to parse links or fetch them.
SECRET_PATTERNS = (
    re.compile(r"(?i)https?://[^\s<>]+[?&](?:access_token|auth_token|id_token|session_token|api_key|apikey|secret|magic_token|token)=[^\s&#]+"),
    re.compile(r"(?i)\b(?:password|passphrase|recovery\s+code)\s*(?:is|:|=)\s*[A-Za-z0-9!@#$%^&*._-]{6,}\b"),
    re.compile(r"(?i)\b(?:one[- ]time|login|sign[- ]in|verification|authentication)\s+code\s*(?:is|:|=)\s*\d{4,10}\b"),
)


def structured_secret(text: str) -> bool:
    return any(pattern.search(text) for pattern in SECRET_PATTERNS)


def decision(scores: dict[str, float], text: str, *, allow_threshold: float = 0.9,
             sensitive_threshold: float = 0.1) -> str:
    if structured_secret(text):
        return "deny"
    if (set(scores) != set(HYPOTHESES) or
            any(isinstance(value, bool) or not isinstance(value, (int, float)) or
                not math.isfinite(value) or not 0 <= value <= 1
                for value in scores.values())):
        return "uncertain"
    if any(scores[key] >= sensitive_threshold
           for key in HYPOTHESES if key != "non_sensitive_content"):
        return "deny"
    return "allow" if scores["non_sensitive_content"] >= allow_threshold else "uncertain"
