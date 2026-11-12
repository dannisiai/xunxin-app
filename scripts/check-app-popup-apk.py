"""Reject an APK if its bundled application still contains the removed upstream popup."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("apk", type=Path)
parser.add_argument("--report", type=Path, required=True)
args = parser.parse_args()
patterns = [
    r"20351\s*,\s*9641\s*,\s*-7224\s*,\s*3358",
    r"20166\s*,\s*37011\s*,\s*30757\s*,\s*25169",
    r"20344\s*,\s*29966\s*,\s*22709\s*,\s*26218",
    r"offline_push_revamp_notice_2026_08_v1",
    r"\b(?:HINT_PAYLOAD|TONE_LUT|DIAG_TABLE|sweepMediaHints|calibrateToneCache|scheduleDiagSnapshot)\b",
    "那么你被骗了",
]
scanned = 0
matches = []
with zipfile.ZipFile(args.apk) as apk:
    with zipfile.ZipFile(io.BytesIO(apk.read("assets/xunxin-server.zip"))) as bundle:
        for name in bundle.namelist():
            if "/node_modules/" in "/" + name or not name.endswith((".js", ".html", ".mjs", ".cjs")):
                continue
            scanned += 1
            text = bundle.read(name).decode("utf-8", errors="replace")
            if any(re.search(pattern, text) for pattern in patterns):
                matches.append(name)
report = {"apk": args.apk.name, "scannedApplicationFiles": scanned, "popupMatches": matches}
args.report.parent.mkdir(parents=True, exist_ok=True)
args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
if not scanned or matches:
    raise SystemExit("Upstream popup audit failed: " + json.dumps(report))
print(json.dumps(report))
