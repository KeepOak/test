"""Removes every "live" mark that check-live.mjs found with nothing behind it (reads its output from stdin)."""
import collections
import re
import sys

bad = collections.defaultdict(set)
for line in sys.stdin:
    m = re.match(r'(.+?\.js): (\S+) has no', line.strip())
    if m:
        bad[m.group(1).replace(chr(92), '/')].add(m.group(2))
for path, ids in bad.items():
    src = open(path, encoding='utf8').read()
    for name in ids:
        src = re.sub(r'\n\s*["\']' + re.escape(name) + r'["\']\s*:\s*true\s*,?', '', src)
        src = re.sub(r'(markLive\(\s*\[[^\]]*?)\s*["\']' + re.escape(name) + r'["\']\s*,?', r'\1', src)
    open(path, 'w', encoding='utf8').write(src)
print({k: len(v) for k, v in bad.items()})
