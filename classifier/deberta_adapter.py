"""Offline DeBERTa disclosure adapter with a fail-closed JSONL interface.

Private JSONL stdin/stdout contract: {"text": ...} -> {"decision": ...}.
Model loading, content and exceptions are never printed on stdout.
"""
import contextlib
import json
import os
from pathlib import Path
import sys

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'

from privacy_policy import HYPOTHESES, decision, structured_secret


def main():
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    config = json.loads(Path(sys.argv[1]).read_text())
    revision = config['revision']
    path = Path(config['model_path']).resolve()
    if (len(revision) != 40 or any(char not in '0123456789abcdef' for char in revision)
            or not path.is_dir() or path.name != revision):
        raise ValueError('Pinned local snapshot path required')
    torch.set_num_threads(2)
    with contextlib.redirect_stdout(sys.stderr):
        tokenizer = AutoTokenizer.from_pretrained(path, local_files_only=True, trust_remote_code=False)
        model = AutoModelForSequenceClassification.from_pretrained(
            path, local_files_only=True, trust_remote_code=False, use_safetensors=True)
        model.eval()
    labels = {str(key).lower(): value for key, value in model.config.label2id.items()}
    entail = labels['entailment']
    contrary = labels.get('not_entailment', labels.get('contradiction'))
    if contrary is None:
        raise ValueError('NLI label mapping unavailable')
    hypotheses = list(HYPOTHESES.values())
    for line in sys.stdin:
        verdict = 'uncertain'
        try:
            text = json.loads(line)['text']
            if not isinstance(text, str) or not text.strip() or len(text.encode()) > 48000:
                raise ValueError('Unsupported input')
            encoded = tokenizer([text]*len(hypotheses), hypotheses,
                                truncation=False, padding=True, return_tensors='pt')
            if encoded['input_ids'].shape[1] > 512:
                raise ValueError('Input too long')
            with torch.inference_mode(), contextlib.redirect_stdout(sys.stderr):
                logits = model(**encoded).logits
                probabilities = torch.softmax(logits[:, [contrary, entail]], dim=-1)[:,1].tolist()
            verdict = decision(dict(zip(HYPOTHESES, probabilities)), text)
        except Exception:
            verdict = 'uncertain'
        print(json.dumps({'decision':verdict}), flush=True)


if __name__ == '__main__':
    main()
