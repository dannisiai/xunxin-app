import argparse, json, os, re, subprocess
from pathlib import Path

parser=argparse.ArgumentParser(description='Sign locally and publish the signed APK plus the automatic update feed')
parser.add_argument('--artifacts',type=Path,required=True)
parser.add_argument('--source',type=Path,required=True)
parser.add_argument('--signing-dir',type=Path,required=True)
parser.add_argument('--java-home',type=Path,required=True)
parser.add_argument('--build-tools',type=Path,required=True)
args=parser.parse_args()
meta=json.loads((args.artifacts/'release-metadata.json').read_text(encoding='utf-8'))
repo=meta['GITHUB_REPOSITORY'];version=meta['SHELL_VERSION_NAME'];tag=meta['RELEASE_TAG']
if repo!='dannisiai/xunxin-app' or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',version):raise SystemExit('Unexpected release metadata')
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
subprocess.run(['gh','release','create',tag,str(signed),str(feed),str(args.artifacts/'popup-audit-signed.json'),'--repo',repo,'--target',meta['GITHUB_SHA'],'--title',f'寻信 {version}','--notes-file',str(download_notes),'--latest'],check=True)
prior=subprocess.run(['gh','api',f'repos/{repo}/releases/tags/android-ota-stable'],capture_output=True,text=True)
if prior.returncode==0:
 subprocess.run(['gh','release','upload','android-ota-stable',str(feed),'--repo',repo,'--clobber'],check=True)
elif 'HTTP 404' in prior.stderr:
 subprocess.run(['gh','release','create','android-ota-stable',str(feed),'--repo',repo,'--target',meta['GITHUB_SHA'],'--title','Android 自动更新通道','--notes','App 固定使用此地址检查更新。','--latest=false'],check=True)
else:raise SystemExit(prior.stderr)
print(json.dumps({'versionName':version,'versionCode':manifest['versionCode'],'apkUrl':manifest['apkUrl'],'sha256':manifest['sha256']}))
