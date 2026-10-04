import os,pathlib,socket,subprocess,tempfile,json,sys
base=pathlib.Path(sys.argv[1]);base.mkdir(exist_ok=False)
owned=pathlib.Path(tempfile.mkdtemp(prefix='mention-jev-semantic-'));data=owned/'data';sock=owned/'socket';sock.mkdir()
port=18991;pg='/usr/lib/postgresql/17/bin/';env=os.environ.copy()
for k in ['DATABASE_URL','TEST_DATABASE_URL','PGHOST','PGPORT','PGDATABASE','PGHOSTADDR','PGSERVICE']:env.pop(k,None)
env.update(JEV_TEST_DATA=str(data),JEV_TEST_SOCKET=str(sock),JEV_TEST_PORT=str(port),JEV_TEST_DATABASE='mention_semantic_owned',JEV_TEST_USER='nate',NODE_ENV='test')
subprocess.run([pg+'initdb','-D',str(data),'-A','trust','--no-locale'],stdout=open(base/'init.log','w'),stderr=subprocess.STDOUT,check=True)
subprocess.run([pg+'pg_ctl','-D',str(data),'-l',str(base/'pg.log'),'-o',f"-h '' -p {port} -k {sock}",'-w','start'],stdout=open(base/'start.log','w'),stderr=subprocess.STDOUT,check=True)
try:
 subprocess.run([pg+'createdb','-h',str(sock),'-p',str(port),'-U','nate','mention_semantic_owned'],env=env,check=True)
 result=subprocess.run(['bash','scripts/test-jev-owned-pg.sh'],env=env,stdout=open(base/'tests.log','w'),stderr=subprocess.STDOUT)
finally:
 stop=subprocess.run([pg+'pg_ctl','-D',str(data),'-m','fast','-w','stop'],stdout=open(base/'stop.log','w'),stderr=subprocess.STDOUT)
(base/'receipt.json').write_text(json.dumps({'data':str(data),'socket':str(sock),'port':port,'exit':result.returncode,'stopExit':stop.returncode,'postmasterAbsent':not (data/'postmaster.pid').exists()},indent=2)+'\n')
raise SystemExit(result.returncode)
