import pathlib,subprocess,os,json,hashlib
r=pathlib.Path('/home/nate/Oxy/Mention/.worktrees/1572-bounded-shadow-20261004'); e=pathlib.Path('/home/nate/Oxy/.agent-evidence/i04-mention-bounded-shadow-20261004')
paths=['packages/backend/src/db/posts/postEvaluationRepository.ts','packages/backend/src/services/PostClassificationService.ts','packages/backend/src/services/contentClassification/jevProduction.ts']
backup={p:(r/p).read_bytes() for p in paths}
for p,data in backup.items():
 out=e/'final-runtime'/p;out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(data)
records=[]
try:
 for p in paths:
  old=subprocess.check_output(['git','show','dfb368638c6aed9985887f6abfe0736922c78ab0:'+p],cwd=r).decode()
  if p.endswith('postEvaluationRepository.ts'):
   start='export async function claimPostEvaluation('; end='\n/**\n * This only records evidence.'
   oldfunc=old[old.index(start):old.index(end,old.index(start))].replace('lockSnapshot(', 'loadSnapshot(')
   s=backup[p].decode();s=s[:s.index(start)]+oldfunc+s[s.index(end,s.index(start)):]
  else:s=old
  (r/p).write_text(s)
  out=e/'baseline-runtime'/p;out.parent.mkdir(parents=True,exist_ok=True);out.write_text(s)
  records.append({'path':p,'baselineSha256':hashlib.sha256(s.encode()).hexdigest(),'finalSha256':hashlib.sha256(backup[p]).hexdigest()})
 env=os.environ.copy();env['TEST_DATABASE_URL']='postgres://nate@127.0.0.1:18643/postgres'
 with (e/'baseline-red.log').open('w') as log:
  run=subprocess.run(['bun','run','test','src/__tests__/services/jevProduction.test.ts','src/__tests__/services/jevSdk.test.ts','src/__tests__/db/postEvaluationRepository.test.ts','src/__tests__/services/postClassification.test.ts','--maxWorkers=1'],cwd=r/'packages/backend',env=env,stdout=log,stderr=subprocess.STDOUT)
 (e/'baseline.json').write_text(json.dumps({'base':'dfb368638c6aed9985887f6abfe0736922c78ab0','note':'Old factory and worker byteexact; old claim function with helper rename only. Additive read-only preparation, pure request extraction and final fixtures retained; no production approval.','exitCode':run.returncode,'runtime':records},indent=2)+'\n')
finally:
 for p,data in backup.items():(r/p).write_bytes(data)
 for p,data in backup.items():assert (r/p).read_bytes()==data
