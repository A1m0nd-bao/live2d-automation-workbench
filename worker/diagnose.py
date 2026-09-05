"""One bounded inference run; save raw events and verify a downloaded PSD."""
import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import quote, urlsplit

import httpx

BASE = 'https://studio-ljsabc-see-through.api-inference.modelscope.net'


def run():
    token = os.environ['SEE_THROUGH_API_TOKEN']
    root = Path(sys.argv[2])
    root.mkdir(parents=True, exist_ok=True)
    def record(stage, **data):
        item = {'time': time.time(), 'stage': stage, **data}
        text = json.dumps(item, ensure_ascii=False).replace(token, '[REDACTED]')
        with (root / 'events.jsonl').open('a') as log:
            log.write(text + '\n')
        print(text[:1800], flush=True)
    with httpx.Client(headers={'Authorization': f'Bearer {token}'}, timeout=60) as client:
        def check(response, stage):
            if not response.is_success:
                record(stage, status=response.status_code, url=str(response.url), body=response.text[:3000])
                response.raise_for_status()
            return response
        image = Path(sys.argv[1])
        with image.open('rb') as handle:
            upload = check(client.post(BASE + '/gradio_api/upload', files={'files': (image.name, handle, 'image/png')}), 'upload').json()
        record('uploaded', reference=upload)
        payload = {'data': [{'path': upload[0], 'orig_name': image.name, 'meta': {'_type': 'gradio.FileData'}}, 768, 42, False]}
        event_id = check(client.post(BASE + '/gradio_api/call/inference', json=payload), 'submit').json()['event_id']
        record('submitted', event_id=event_id)
        started = time.monotonic()
        with client.stream('GET', BASE + '/gradio_api/call/inference/' + event_id, timeout=60) as response:
            if not response.is_success:
                response.read()
            check(response, 'listen')
            kind = ''
            lines = []
            for line in response.iter_lines():
                if time.monotonic() - started > 600:
                    raise TimeoutError('No terminal event within 600 seconds')
                if line.startswith('event:'):
                    kind = line[6:].strip()
                elif line.startswith('data:'):
                    lines.append(line[5:].strip())
                elif not line and lines:
                    data = json.loads('\n'.join(lines))
                    lines = []
                    record('event', event=kind, data=data)
                    if kind == 'error':
                        raise RuntimeError('Upstream emitted error: ' + json.dumps(data))
                    if kind != 'complete':
                        continue
                    if not isinstance(data, list) or not data or not isinstance(data[0], dict):
                        raise RuntimeError('Completed event has no FileData output')
                    file = data[0]
                    # Always fetch a returned server path via the authenticated API
                    # host. The browser-facing ms.show URL rejects API tokens.
                    path = file.get('path')
                    url = BASE + '/gradio_api/file=' + quote(path, safe='/') if path and not path.startswith('http') else file.get('url') or path
                    if not url or urlsplit(url).netloc != urlsplit(BASE).netloc:
                        raise RuntimeError('Unexpected download origin')
                    record('download', url=url, advertised_url=file.get('url'))
                    result = check(client.get(url, timeout=120), 'download')
                    if result.content[:6] != b'8BPS\x00\x01':
                        raise RuntimeError('Download is not a PSD: ' + repr(result.content[:100]))
                    target = root / 'ana.psd'
                    target.write_bytes(result.content)
                    from psd_tools import PSDImage
                    psd = PSDImage.open(target)
                    record('verified', file=str(target), bytes=len(result.content), size=list(psd.size), layers=[layer.name for layer in psd])
                    psd.composite().save(root / 'preview.png')
                    return
        raise RuntimeError('Stream ended without a terminal event')


if __name__ == '__main__':
    run()
