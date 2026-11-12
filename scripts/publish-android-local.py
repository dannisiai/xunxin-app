import argparse, json, os, re, subprocess, sys
from pathlib import Path

parser=argparse.ArgumentParser(description='Sign locally and publish the signed APK plus the automatic update feed')
parser.add_argument('--artifacts',type=Path,required=True)
parser.add_argument('--source',type=Path,required=True)
parser.add_argument('--signing-dir',type=Path,required=True)
parser.add_argument('--java-home',type=Path,required=True)
parser.add_argument('--build-tools',type=Path,required=True)
parser.add_argument('--r2-endpoint', default=os.environ.get('XUNXIN_R2_ENDPOINT'))
parser.add_argument('--r2-bucket', default=os.environ.get('XUNXIN_R2_BUCKET'))
parser.add_argument('--r2-base-url', default=os.environ.get('XUNXIN_R2_BASE_URL'))
parser.add_argument('--r2-profile', default=os.environ.get('XUNXIN_R2_PROFILE'))
parser.add_argument('--prepare-only', action='store_true', help='Sign and verify locally without uploading or changing any update feed')
args=parser.parse_args()
meta=json.loads((args.artifacts/'release-metadata.json').read_text(encoding='utf-8'))
repo=meta['GITHUB_REPOSITORY'];version=meta['SHELL_VERSION_NAME'];tag=meta['RELEASE_TAG']
if repo!='dannisiai/xunxin-app' or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',version):raise SystemExit('Unexpected release metadata')
r2 = (args.r2_endpoint, args.r2_bucket, args.r2_base_url)
if any(r2) and not all(r2): raise SystemExit('R2 publishing requires endpoint, bucket and public base URL')
mirror_url = meta.get('SHELL_UPDATE_MIRROR_URL', '').strip()
if mirror_url and not args.prepare_only and (not all(r2) or args.r2_base_url.rstrip('/') + '/android/version.json' != mirror_url):
 raise SystemExit('R2 publisher must match the update source embedded in the APK')
private=json.loads((args.signing_dir/'signing-recovery.private.json').read_text(encoding='utf-8-sig'))
public=json.loads((args.signing_dir/'signing-public.json').read_text(encoding='utf-8-sig'))
if meta['SIGNING_CERT_SHA256'].lower()!=public['certificateSha256'].lower():raise SystemExit('Signing certificate configuration mismatch')
unsigned=args.artifacts/f'xunxin-{version}-unsigned.apk';aligned=args.artifacts/f'xunxin-{version}-aligned.apk';signed=args.artifacts/'xunxin.apk'
env=os.environ.copy();env['JAVA_HOME']=str(args.java_home)
env['XUNXIN_SIGN_STORE_PASSWORD']=private['keystorePassword'];env['XUNXIN_SIGN_KEY_PASSWORD']=private['keyPassword']
java=args.java_home/'bin/java.exe';jar=args.build_tools/'lib/apksigner.jar'
subprocess.run([str(args.build_tools/'zipalign.exe'),'-p','-f','4',str(unsigned),str(aligned)],check=True,env=env)
subprocess.run([str(java),'-jar',str(jar),'sign','--ks',str(args.signing_dir/'xunxin-release.p12'),'--ks-type',private['storeType'],'--ks-key-alias',private['alias'],'--ks-pass','env:XUNXIN_SIGN_STORE_PASSWORD','--key-pass','env:XUNXIN_SIGN_KEY_PASSWORD','--v1-signing-enabled','true','--v2-signing-enabled','true','--v3-signing-enabled','true','--out',str(signed),str(aligned)],check=True,env=env)
# This adapter contains only public tool paths; passwords are supplied to the signing subprocess via its environment.
adapter=args.artifacts/'apksigner-local.cmd'
adapter.write_text('@"'+str(java)+'" -jar "'+str(jar)+'" %*\r\n',encoding='utf-8')
feed=args.artifacts/'version.json'
download_notes=args.artifacts/'download-notes.md'
subprocess.run(['python',str(args.source/'scripts/create-android-update-feed.py'),'--apk',str(signed),'--apk-url',f'https://github.com/{repo}/releases/download/{tag}/{signed.name}','--notes-file',str(args.artifacts/'notes.md'),'--download-notes-output',str(download_notes),'--expected-certificate-sha256',public['certificateSha256'],'--output',str(feed),'--aapt',str(args.build_tools/'aapt.exe'),'--apksigner',str(adapter)],check=True,env=env)
subprocess.run(['python',str(args.source/'scripts/check-app-popup-apk.py'),str(signed),'--report',str(args.artifacts/'popup-audit-signed.json')],check=True)
manifest=json.loads(feed.read_text(encoding='utf-8'))
if manifest['versionCode']!=int(meta['SHELL_VERSION_CODE']) or manifest['versionName']!=version:raise SystemExit('Signed APK version mismatch')
if args.prepare_only:
 print(json.dumps({'versionName':version,'versionCode':manifest['versionCode'],'apk':str(signed),'sha256':manifest['sha256']}))
 raise SystemExit(0)
subprocess.run(['gh','release','create',tag,str(signed),str(feed),str(args.artifacts/'popup-audit-signed.json'),'--repo',repo,'--target',meta['GITHUB_SHA'],'--title',f'寻信 {version}','--notes-file',str(download_notes),'--latest'],check=True)
if all(r2):
 r2_feed=args.artifacts/'r2'/'version.json'
 profile_args=['--profile',args.r2_profile] if args.r2_profile else []
 subprocess.run([sys.executable,str(args.source/'scripts/publish-android-r2.py'),'--apk',str(signed),'--manifest',str(feed),'--endpoint',args.r2_endpoint,'--bucket',args.r2_bucket,'--base-url',args.r2_base_url,'--output',str(r2_feed),*profile_args],check=True)
 feed=r2_feed
 manifest=json.loads(feed.read_text(encoding='utf-8'))
 download_notes.write_text(f"[自定义域名下载（默认）]({manifest['apkUrl']}) · [GitHub 原始下载（备用）]({manifest['fallbackApkUrl']})\n\n"+(args.artifacts/'notes.md').read_text(encoding='utf-8-sig'),encoding='utf-8')
 subprocess.run(['gh','release','edit',tag,'--repo',repo,'--notes-file',str(download_notes)],check=True)
prior=subprocess.run(['gh','api',f'repos/{repo}/releases/tags/android-ota-stable'],capture_output=True,text=True,encoding='utf-8',errors='replace')
if prior.returncode==0:
 subprocess.run(['gh','release','upload','android-ota-stable',str(feed),'--repo',repo,'--clobber'],check=True)
elif 'HTTP 404' in prior.stderr:
 subprocess.run(['gh','release','create','android-ota-stable',str(feed),'--repo',repo,'--target',meta['GITHUB_SHA'],'--title','Android 自动更新通道','--notes','App 固定使用此地址检查更新。','--latest=false'],check=True)
else:raise SystemExit(prior.stderr)
print(json.dumps({'versionName':version,'versionCode':manifest['versionCode'],'apkUrl':manifest['apkUrl'],'sha256':manifest['sha256']}))
