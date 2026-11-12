#!/usr/bin/env python3
"""Generate version.json from the actual signed APK. Does not upload or execute the app."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit


def https_url(value):
    url = urlsplit(value)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.fragment:
        raise ValueError("apkUrl must be an HTTPS URL without credentials or fragments")
    return value


def tool(name, explicit):
    if explicit:
        return explicit
    root = Path(os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT") or "") / "build-tools"
    versions = sorted((p for p in root.glob("*") if p.is_dir()),
                      key=lambda p: tuple(int(n) for n in re.findall(r"\d+", p.name)))
    for version in reversed(versions):
        for suffix in ("", ".exe", ".bat"):
            target = version / (name + suffix)
            if target.is_file():
                return str(target)
    raise ValueError("Android build-tools not found; set ANDROID_HOME or pass --" + name)


def output(command):
    result = subprocess.run(command, check=True, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", type=Path, required=True)
    parser.add_argument("--apk-url", type=https_url, required=True)
    parser.add_argument("--notes-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-certificate-sha256", required=True)
    parser.add_argument("--package-name", default="app.floatphone.shell")
    parser.add_argument("--force-update", action="store_true")
    parser.add_argument("--aapt")
    parser.add_argument("--apksigner")
    args = parser.parse_args()
    certificate = args.expected_certificate_sha256.replace(":", "").lower()
    if not re.fullmatch(r"[0-9a-f]{64}", certificate):
        parser.error("expected certificate SHA-256 must be 64 hexadecimal characters")
    if not args.apk.is_file() or not 0 < args.apk.stat().st_size <= 2 * 1024**3:
        parser.error("APK missing, empty or larger than 2 GiB")
    signing = output([tool("apksigner", args.apksigner), "verify", "--min-sdk-version", "26", "--print-certs", str(args.apk)])
    signers = set(re.findall(r"^(?:Signer #\d+|V[0-9]+(?:\.[0-9]+)? Signer(?: #\d+)?):? certificate SHA-256 digest: ([0-9a-fA-F]{64})", signing, re.M))
    if {s.lower() for s in signers} != {certificate}:
        raise ValueError("APK signing certificate differs from the pinned production certificate")
    if "CN=Android Debug" in signing:
        raise ValueError("Debug-signed APKs must not be published to the production OTA channel")
    badging = output([tool("aapt", args.aapt), "dump", "badging", str(args.apk)])
    package = re.search(r"^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']+)'", badging, re.M)
    if not package or package[1] != args.package_name:
        raise ValueError("APK package name mismatch")
    code, name = int(package[2]), package[3]
    if not 0 < code <= 2147483647 or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,79}", name):
        raise ValueError("Invalid APK version")
    notes = args.notes_file.read_text(encoding="utf-8-sig")
    if len(notes.encode("utf-16-le")) // 2 > 20000:
        raise ValueError("Release notes must not exceed 20000 UTF-16 code units")
    digest = hashlib.sha256()
    with args.apk.open("rb") as apk:
        for chunk in iter(lambda: apk.read(1024 * 1024), b""):
            digest.update(chunk)
    manifest = {"versionCode": code, "versionName": name, "apkUrl": args.apk_url,
                "sha256": digest.hexdigest(), "forceUpdate": args.force_update, "releaseNotes": notes}
    content = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    if len(content.encode("utf-8")) > 65536:
        raise ValueError("version.json exceeds 64 KiB")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(args.output)
    print(f"Generated {args.output}: {name} ({code}), SHA-256 {digest.hexdigest()}")


if __name__ == "__main__":
    main()
