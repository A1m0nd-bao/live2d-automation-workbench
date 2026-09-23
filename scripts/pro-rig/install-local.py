"""Stage Pro scripts and their local JS imports beside an existing desktop relay.

No credentials are read; caller restarts the relay after checking active jobs.
"""
import argparse,json,re,shutil,time
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--runtime',type=Path,required=True);p.add_argument('--core',type=Path,required=True);a=p.parse_args()
root=Path(__file__).resolve().parents[2];dest=a.runtime.resolve();core=a.core.resolve()
if not core.is_file():raise SystemExit('Official Cubism Web Core file is required')
if not (dest/'worker/app/native_export.py').is_file():raise SystemExit('Existing local relay required')
backup=dest/f'backup-before-pro-rig-{int(time.time())}';backup.mkdir()
shutil.copy2(dest/'worker/app/native_export.py',backup/'native_export.py');shutil.copy2(dest/'run.sh',backup/'run.sh')
shutil.copy2(root/'worker/app/native_export.py',dest/'worker/app/native_export.py')
for source in (root/'scripts/pro-rig').glob('*'):
 if source.is_file():
  target=dest/source.relative_to(root);target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)
seen=set()
def stage(source):
 source=source.resolve()
 if source in seen:return
 seen.add(source);target=dest/source.relative_to(root);target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)
 for dep in re.findall(r"(?:from\s+|import\s*)['\"]([^'\"]+)['\"]",source.read_text()):
  if dep.startswith('.'):stage(source.parent/dep)
stage(root/'src/vendor/stretchystudio/io/live2d/cmo3writer.js')
license=root/'src/vendor/stretchystudio/LICENSE';shutil.copy2(license,dest/'src/vendor/stretchystudio/LICENSE')
(dest/'package.json').write_text(json.dumps({'private':True,'type':'module'}))
shutil.copy2(core,dest/'native-export/live2dcubismcore.min.js')
run=dest/'run.sh';s=run.read_text();setting='export MORPH_CUBISM_WEB_CORE="$RUNTIME_ROOT/native-export/live2dcubismcore.min.js"'
if 'export MORPH_CUBISM_WEB_CORE=' not in s:s=s.replace('cd "$WORKER_ROOT"',setting+'\nexport MORPH_EXPORT_NODE="'+str(Path(shutil.which('node')).resolve())+'"\n\ncd "$WORKER_ROOT"')
run.write_text(s)
print('Installed Pro rig; backup:',backup)

