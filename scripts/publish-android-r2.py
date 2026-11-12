#!/usr/bin/env python3
"""Mirror an already signed GitHub release APK and its generated manifest to R2."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request
from urllib.error import HTTPError
from urllib.parse import urlsplit


def read_public(url):
    with urllib.request.urlopen(url, timeout=20) as response:
        data = response.read(65537)
        if len(data) > 65536:
            raise SystemExit('Public manifest exceeds 64 KiB')
        return json.loads(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apk', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--base-url', required=True, help='Public HTTPS custom domain, e.g. https://download.xunxin.shop')
    parser.add_argument('--endpoint', required=True, help='Private Cloudflare R2 S3 endpoint, not the public domain')
    parser.add_argument('--bucket', required=True)
    parser.add_argument('--profile', help='Local AWS CLI profile containing the R2 credentials')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()

    base = args.base_url.rstrip('/')
    url = urlsplit(base)
    if (url.scheme != 'https' or not url.hostname or url.netloc != url.hostname or url.path
            or url.query or url.fragment or url.hostname.endswith(('.r2.dev', '.r2.cloudflarestorage.com'))):
        parser.error('--base-url must be the HTTPS custom domain origin')
    if not re.fullmatch(r'https://[a-f0-9]{32}(?:\.eu|\.fedramp)?\.r2\.cloudflarestorage\.com', args.endpoint):
        parser.error('--endpoint must be the Cloudflare R2 S3 endpoint')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', args.bucket):
        parser.error('Invalid R2 bucket name')

    manifest = json.loads(args.manifest.read_text(encoding='utf-8'))
    code, name = manifest['versionCode'], manifest['versionName']
    original = manifest.get('fallbackApkUrl', manifest['apkUrl']).removeprefix('https://gh-proxy.com/')
    if type(code) is not int or not 0 < code <= 2147483647 or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', name):
        raise SystemExit('Invalid release version')
    asset = f'https://github.com/dannisiai/xunxin-app/releases/download/android-v{name}-{code}/xunxin.apk'
    if original != asset:
        raise SystemExit('The manifest must point to the matching official GitHub release asset')
    with args.apk.open('rb') as file:
        digest = hashlib.file_digest(file, 'sha256').hexdigest()
    size = args.apk.stat().st_size
    if digest != manifest['sha256'] or not 0 < size <= 2 * 1024**3:
        raise SystemExit('The local APK does not match the signed release manifest')
    release = json.loads(subprocess.check_output([
        'gh', 'api', f'repos/dannisiai/xunxin-app/releases/tags/android-v{name}-{code}'
    ], encoding='utf-8'))
    if release.get('draft') or not any(item.get('browser_download_url') == asset
            and item.get('digest') == 'sha256:' + digest and item.get('size') == size
            and item.get('state') == 'uploaded' for item in release.get('assets', [])):
        raise SystemExit('GitHub does not report an identical published APK')

    stable = base + '/android/version.json'
    try:
        current = read_public(stable)
        if current['versionCode'] > code or (current['versionCode'] == code and current['sha256'] != digest):
            raise SystemExit('Refusing to roll back or replace an existing version')
    except HTTPError as error:
        if error.code != 404:
            raise

    key = f'android/releases/{code}/{digest[:16]}/xunxin.apk'
    manifest.update(apkUrl=base + '/' + key, fallbackApkUrl=original)
    env = os.environ.copy()
    # Avoid optional SDK checksums unsupported by some S3-compatible multipart paths.
    env['AWS_REQUEST_CHECKSUM_CALCULATION'] = 'when_required'
    env['AWS_RESPONSE_CHECKSUM_VALIDATION'] = 'when_required'
    cli = ['aws', '--endpoint-url', args.endpoint, '--region', 'auto']
    if args.profile:
        cli += ['--profile', args.profile]

    def upload(local, dest, content_type, cache_control, *flags):
        subprocess.run([*cli, 's3', 'cp', str(local), f's3://{args.bucket}/{dest}', '--no-progress',
                        '--content-type', content_type, '--cache-control', cache_control, *flags], check=True, env=env)

    upload(args.apk, key, 'application/vnd.android.package-archive', 'public,max-age=31536000,immutable',
           '--content-disposition', f'attachment; filename="xunxin-{name}.apk"')
    probe = urllib.request.Request(manifest['apkUrl'], headers={'Range': 'bytes=0-3', 'Accept-Encoding': 'identity'})
    with urllib.request.urlopen(probe, timeout=20) as response:
        if (response.status != 206 or response.headers.get('Content-Range') != f'bytes 0-3/{size}'
                or response.read(4) != b'PK\x03\x04'):
            raise SystemExit('Custom domain did not return the expected APK range; manifest left unchanged')

    content = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    if len(content) > 65536:
        raise SystemExit('Manifest exceeds 64 KiB')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(content)
    upload(args.output, 'android/version.json', 'application/json; charset=utf-8', 'no-store, max-age=0')
    if read_public(stable) != manifest:
        raise SystemExit('Published R2 manifest does not match local manifest')
    print(stable)


if __name__ == '__main__':
    main()
