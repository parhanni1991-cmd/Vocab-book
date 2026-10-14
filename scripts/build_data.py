#!/usr/bin/env python3
"""사전 Markdown(한자어/*.md, 고유어/*.md)을 앱용 app/words.json으로 변환한다.

사용법:
    python3 scripts/build_data.py          # app/words.json 생성
    python3 scripts/build_data.py --check  # 커밋된 words.json이 최신인지 확인
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'app' / 'words.json'
KINDS = ['한자어', '고유어']

HEAD_RE = re.compile(r'^### (?P<word>[^(〔]+?)(?:\((?P<hanja>[^)]*)\))?(?P<suffix>[^(〔 ]*) 〔(?P<pos>[^〕]+)〕\s*$')
FIELD_RE = re.compile(r'^- \*\*(?P<name>[^*]+)\*\*: (?P<value>.*)$')
TITLE_RE = re.compile(r'^# \S+ (?P<no>\d+)\. (?P<name>.+)$')


def parse_chapter(path, kind):
    lines = path.read_text(encoding='utf-8').splitlines()
    m = TITLE_RE.match(lines[0])
    if not m:
        raise ValueError(f'{path}: 첫 줄 제목 형식이 다르다: {lines[0]!r}')
    topic = {'kind': kind, 'no': int(m['no']), 'name': m['name'].strip(),
             'intro': ' '.join(l[2:].strip() for l in lines if l.startswith('> '))}
    entries, cur = [], None
    for line in lines:
        h = HEAD_RE.match(line)
        if h:
            cur = {'word': h['word'] + h['suffix'], 'hanja': h['hanja'] or '',
                   'pos': h['pos'], 'kind': kind, 'topic': topic['no'], 'fields': {}}
            entries.append(cur)
            continue
        if line.startswith('### '):
            raise ValueError(f'{path}: 표제어 줄 형식이 다르다: {line!r}')
        f = FIELD_RE.match(line)
        if f and cur is not None:
            cur['fields'][f['name'].strip()] = f['value'].strip()
    return topic, entries


def build():
    topics, words = [], []
    for kind in KINDS:
        for path in sorted((ROOT / kind).glob('[0-9][0-9]-*.md')):
            topic, entries = parse_chapter(path, kind)
            topics.append(topic)
            words.extend(entries)
    for i, w in enumerate(words):
        w['id'] = f"{'h' if w['kind'] == '한자어' else 'g'}{i:03d}"
        missing = [k for k in ('뜻', '예문') if not w['fields'].get(k)]
        if missing:
            raise ValueError(f"{w['word']}: 필수 항목 누락 {missing}")
    return {'topics': topics, 'words': words}


def dump(data):
    return json.dumps(data, ensure_ascii=False, indent=1) + '\n'


def main():
    text = dump(build())
    if '--check' in sys.argv:
        if not OUT.exists() or OUT.read_text(encoding='utf-8') != text:
            print('app/words.json이 최신이 아니다. python3 scripts/build_data.py를 실행하라.')
            sys.exit(1)
        print('app/words.json 최신 상태')
        return
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(text, encoding='utf-8')
    data = json.loads(text)
    counts = {k: sum(w['kind'] == k for w in data['words']) for k in KINDS}
    print(f"app/words.json 생성: {len(data['words'])}개 {counts}")


if __name__ == '__main__':
    main()
