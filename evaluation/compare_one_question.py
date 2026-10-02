"""Exploratory one-question comparison on reused synthetic data only."""
import contextlib
import json
import os
from pathlib import Path
import resource
import sys
import time

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

ROOT = Path(__file__).resolve().parents[1]
MODEL_REVISION = '8e7e5af5983a0ddb1a5b45a38b129ab69e2258e8'
MODEL = ROOT / '.models/models--MoritzLaurer--deberta-v3-base-zeroshot-v2.0/snapshots' / MODEL_REVISION
HYPOTHESIS = ('This email reveals confidential information about a specific person, '
              'such as a medical fact, prescription, password, access credential, '
              'financial account detail, government identifier, or intimate personal fact.')
THRESHOLD = 0.1


def main():
    torch.set_num_threads(2)
    tokenizer = AutoTokenizer.from_pretrained(MODEL, local_files_only=True, trust_remote_code=False)
    with contextlib.redirect_stdout(sys.stderr):
        model = AutoModelForSequenceClassification.from_pretrained(
            MODEL, local_files_only=True, trust_remote_code=False, use_safetensors=True)
        model.eval()
    labels = {str(key).lower(): value for key, value in model.config.label2id.items()}
    entail = labels['entailment']
    contrary = labels.get('not_entailment', labels.get('contradiction'))
    if contrary is None:
        raise ValueError('NLI label mapping unavailable')
    result = {'purpose':'exploratory comparison on previously seen synthetic data',
              'model_revision':MODEL_REVISION,'hypothesis':HYPOTHESIS,
              'threshold':THRESHOLD,'device':'cpu','corpora':{}}
    for name in ['validation-v1','validation-v2']:
        corpus=json.loads((ROOT / 'evaluation' / f'{name}.json').read_text())
        rows=[]
        for case in corpus:
            if case.get('category') == 'length_stress':
                continue
            started=time.perf_counter()
            encoded=tokenizer(case['text'],HYPOTHESIS,truncation=False,return_tensors='pt')
            tokens=encoded['input_ids'].shape[1]
            if tokens>512:
                decision='uncertain';score=None
            else:
                with torch.inference_mode():
                    logits=model(**encoded).logits[0]
                    score=float(torch.softmax(logits[[contrary,entail]],dim=-1)[1])
                decision='deny' if score>=THRESHOLD else 'allow'
            rows.append({'id':case['id'],'expected':case['expected'],
                         'decision':decision,'score':score,'tokens':tokens,
                         'seconds':time.perf_counter()-started})
        result['corpora'][name]={'rows':rows}
        for expected in ['allow','deny']:
            cases=[r for r in rows if r['expected']==expected]
            result['corpora'][name][expected]={decision:sum(r['decision']==decision for r in cases)
                                                 for decision in ['allow','deny','uncertain']}
    result['peak_rss_mib']=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/(1024**2 if sys.platform=='darwin' else 1024)
    path=ROOT / 'evaluation' / 'one-question-comparison.json'
    path.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({name:{key:corpus[key] for key in ['allow','deny']}
                      for name,corpus in result['corpora'].items()},indent=2))

if __name__=='__main__':
    main()
