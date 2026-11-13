import argparse, json, os, re, shutil, subprocess, sys
from pathlib import Path

parser=argparse.ArgumentParser(description='Sign locally and stage the APK and update feed for the Japan server')
parser.add_argument('--artifacts',type=Path,required=True)
parser.add_argument('--source',type=Path,required=True)
parser.add_argument('--signing-dir',type=Path,required=True)
parser.add_argument('--java-home',type=Path,required=True)
parser.add_argument('--build-tools',type=Path,required=True)
parser.add_argument('--prepare-only', action='store_true', help='Sign and verify without staging the Japan server directory')
args=parser.parse_args()
meta=json.loads((args.artifacts/'release-metadata.json').read_text(encoding='utf-8'))
repo=meta['GITHUB_REPOSITORY'];version=meta['SHELL_VERSION_NAME'];tag=meta['RELEASE_TAG']
if repo!='dannisiai/xunxin-app' or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',version):raise SystemExit('Unexpected release metadata')
if meta.get('SHELL_UPDATE_URL') != 'https://xunxin.shop/downloads/android/version.json':
 raise SystemExit('Expected release metadata for an APK built with the Japan update server')
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
force=['--force-update'] if str(meta.get('FORCE_UPDATE', '')).lower() == 'true' else []
subprocess.run([sys.executable,str(args.source/'scripts/create-android-update-feed.py'),'--apk',str(signed),'--notes-file',str(args.artifacts/'notes.md'),'--download-notes-output',str(download_notes),'--expected-certificate-sha256',public['certificateSha256'],'--output',str(feed),'--aapt',str(args.build_tools/'aapt.exe'),'--apksigner',str(adapter),*force],check=True,env=env)
subprocess.run(['python',str(args.source/'scripts/check-app-popup-apk.py'),str(signed),'--report',str(args.artifacts/'popup-audit-signed.json')],check=True)
manifest=json.loads(feed.read_text(encoding='utf-8'))
if manifest['versionCode']!=int(meta['SHELL_VERSION_CODE']) or manifest['versionName']!=version:raise SystemExit('Signed APK version mismatch')
if args.prepare_only:
 print(json.dumps({'versionName':version,'versionCode':manifest['versionCode'],'apk':str(signed),'sha256':manifest['sha256']}))
 raise SystemExit(0)
stage=args.artifacts/'japan-ota'
stage.mkdir(exist_ok=True)
apk=stage/f"xunxin-{version}-{manifest['versionCode']}.apk"
shutil.copyfile(signed,apk)
shutil.copyfile(feed,stage/'version.json')
print(json.dumps({'versionName':version,'versionCode':manifest['versionCode'],'apk':str(apk),'manifest':str(stage/'version.json'),'apkUrl':manifest['apkUrl'],'sha256':manifest['sha256']}))
