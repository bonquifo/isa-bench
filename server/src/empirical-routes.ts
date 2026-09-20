import type { FastifyInstance, FastifyRequest } from 'fastify'
import { buildEmpiricalSchedule, canonicalJson, decodeCanonicalBase64, EmpiricalJobSpecSchema, EmpiricalJobTemplateSchema, parseEmpiricalAdapter, type EmpiricalJobTemplate, type JsonValue } from '@isa-sim/contracts'
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hash, type EmpiricalRunnerState, type EmpiricalStore, type Row } from './empirical.js'
import { certificateRole } from './tls-role.js'

interface Envelope<T=Record<string,unknown>>{algorithm:'Ed25519';keyId:string;payload:T;signature:string;signedAt:string}
interface Operation extends Record<string,unknown>{operation:string;runnerId:string;keyId:string;requestId:string;sequence:string;nonce:string;timestamp:string}
const FRESH_MS=5*60_000
const BASE_KEYS=['keyId','nonce','operation','requestId','runnerId','sequence','timestamp']

export function empiricalProtocolPath(url:string):boolean{
  return url.startsWith('/api/empirical/enrollment/challenges')||url.startsWith('/api/empirical/enrollment/complete')||url.startsWith('/api/empirical/runner/')
}

export async function registerEmpiricalRoutes(app:FastifyInstance,store:EmpiricalStore,dataDir:string,artifactMaxBytes=64*1024*1024,requireMtls=false,adminFingerprints:readonly string[]=[]):Promise<void>{
  const signer=loadSigner(join(dataDir,'orchestrator-ed25519.pk8'))
  const signerPublic=canonicalPublicKey(createPublicKey(signer).export({format:'der',type:'spki'}).toString('base64'))
  const chunks=join(dataDir,'empirical-upload-chunks'),artifacts=join(dataDir,'empirical-artifacts')
  mkdirSync(chunks,{recursive:true});mkdirSync(artifacts,{recursive:true})
  const chunkMax=Math.min(4*1024*1024,artifactMaxBytes),runnerQuota=artifactMaxBytes*4

  app.post('/api/empirical/enrollment/tokens',async(request,reply)=>guard(reply,()=>store.issueEnrollmentToken(integer(object(request.body).ttlMs,600_000)),store,'enrollment-token.issue'))
  app.post('/api/empirical/enrollment/challenges',async(request,reply)=>guard(reply,()=>{
    const body=object(request.body),identity=validateIdentity(object(body.identity))
    return store.createChallenge({tokenId:text(body.tokenId),token:text(body.token),...identity})
  },store,'enrollment.challenge'))
  app.post('/api/empirical/enrollment/complete',async(request,reply)=>guard(reply,()=>{
    const envelope=request.body as Envelope<{challengeId:string;nonce:string}>
    const challenge=store.challenge(text(envelope?.payload?.challengeId))
    if(!challenge||challenge.used_at||Date.parse(String(challenge.expires_at))<=Date.now())throw new Error('challenge replay or expiry')
    verifyEnvelope(envelope,String(challenge.public_key),String(challenge.key_id))
    if(envelope.payload.nonce!==challenge.nonce)throw new Error('challenge nonce mismatch')
    const credential=signEnvelope(signer,{runnerId:challenge.runner_id,keyId:challenge.key_id,publicKey:challenge.public_key,state:'pending',sequence:'0',issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+31_536_000_000).toISOString()})
    store.completeChallenge(String(challenge.id),JSON.stringify(credential))
    return {credential,orchestratorPublicKey:signerPublic}
  },store,'enrollment.complete'))

  app.get('/api/empirical/runners',async()=>({runners:store.listRunners()}))
  app.get('/api/empirical/overview',async()=>({
    runners:store.listRunners(),
    manifests:store.sqlite.prepare('SELECT runner_id,sequence,observed_at,expires_at,envelope_json FROM empirical_manifests ORDER BY observed_at DESC').all(),
    jobs:store.sqlite.prepare('SELECT id,state,version,runner_id,lease_id,lease_expires_at,artifact_id,created_at,updated_at FROM empirical_jobs ORDER BY created_at DESC').all(),
    artifacts:store.sqlite.prepare('SELECT hash,runner_id,job_id,size,index_json,created_at FROM empirical_artifacts ORDER BY created_at DESC').all(),
  }))
  app.post('/api/empirical/jobs',async(request,reply)=>guard(reply,()=>{
    const spec=validateJobSpec(object(request.body));return store.createJob(text(spec.jobId),spec)
  },store,'job.create'))
  for(const state of ['approved','quarantined','revoked'] as const){
    app.post(`/api/empirical/runners/:id/${state==='approved'?'approve':state}`,async(request,reply)=>guard(reply,()=>{
      const id=text((request.params as {id:string}).id),runner=store.runner(id);if(!runner)throw new Error('runner not found')
      const requested=typeof request.body==='object'&&request.body?object(request.body):{}
      const certFingerprint=requested.certFingerprint===undefined?undefined:text(requested.certFingerprint).replaceAll(':','').toLowerCase()
      if(certFingerprint!==undefined&&!/^[a-f0-9]{64}$/.test(certFingerprint))throw new Error('invalid runner certificate fingerprint')
      const expiresAt=new Date(Date.now()+31_536_000_000).toISOString()
      const credential=signEnvelope(signer,{runnerId:id,keyId:runner.key_id,publicKey:runner.public_key,state,sequence:String(Number(runner.credential_sequence)+1),issuedAt:new Date().toISOString(),expiresAt})
      store.setRunnerCredential(id,state as EmpiricalRunnerState,JSON.stringify(credential),expiresAt,certFingerprint)
      return {credential,orchestratorPublicKey:signerPublic}
    },store,`runner.${state}`))
  }
  app.post('/api/empirical/runner/credential',async(request,reply)=>runnerGuard(store,request,reply,requireMtls,adminFingerprints,'credential.get',{},payload=>{
    const runner=store.runner(payload.runnerId);if(!runner?.credential_json)throw new Error('credential unavailable')
    return {credential:JSON.parse(String(runner.credential_json)),orchestratorPublicKey:signerPublic}
  },[],true))

  app.post('/api/empirical/runner/manifests',async(request,reply)=>runnerGuard(store,request,reply,requireMtls,adminFingerprints,'manifest.publish',{},payload=>{
    const manifest=object(payload.manifest),now=Date.now(),observed=Date.parse(text(manifest.observedAt)),expires=Date.parse(text(manifest.expiresAt))
    if(manifest.runnerId!==payload.runnerId||manifest.sequence!==payload.sequence||!Number.isFinite(observed)||!Number.isFinite(expires)||observed>now+FRESH_MS||expires<=now||expires-observed>86_400_000)throw new Error('invalid manifest time/binding')
    validateManifest(manifest)
    store.acceptManifest(payload.runnerId,integer(payload.sequence),new Date(observed).toISOString(),new Date(expires).toISOString(),JSON.stringify(request.body),payload.requestId,payload.nonce)
    return {accepted:true}
  },['manifest']))

  app.post('/api/empirical/runner/jobs/lease',async(request,reply)=>runnerGuard(store,request,reply,requireMtls,adminFingerprints,'job.lease',{},payload=>{
    store.transaction(()=>store.consumeOperation(payload.runnerId,payload.requestId,payload.nonce,integer(payload.sequence),'job.lease',payload.runnerId))
    const job=store.lease(payload.runnerId,60_000);if(!job){reply.code(204);return undefined}
    const untrusted=validateJobSpec(object(JSON.parse(String(job.spec_json)))),issuedAt=new Date().toISOString()
    const spec=EmpiricalJobSpecSchema.parse({...untrusted,jobId:job.id,leaseId:job.lease_id,runnerId:payload.runnerId,sequence:String(Number(job.version)+1),nonce:job.lease_nonce,issuedAt,expiresAt:job.lease_expires_at,leaseExpiresAt:job.lease_expires_at})
    return signEnvelope(signer,spec,issuedAt)
  }))

  for(const routeKind of ['accept','heartbeat','start','events','finish','fail'] as const){
    const kind=routeKind==='events'?'event':routeKind
    app.post(`/api/empirical/runner/jobs/:id/${routeKind}`,async(request,reply)=>{
      const jobId=text((request.params as {id:string}).id)
      return runnerGuard(store,request,reply,requireMtls,adminFingerprints,`job.${kind}`,{jobId},payload=>{
        if(payload.kind!==kind)throw new Error('signed event kind differs from route')
        if(kind==='finish'){const data=object(payload.data),artifactHash=validHash(text(data.artifactHash)),artifact=store.sqlite.prepare('SELECT hash FROM empirical_artifacts WHERE hash=? AND runner_id=? AND job_id=?').get(artifactHash,payload.runnerId,jobId) as Row|undefined,job=store.sqlite.prepare('SELECT artifact_id FROM empirical_jobs WHERE id=?').get(jobId) as Row|undefined;if(!artifact||job?.artifact_id!==artifactHash)throw new Error('finish requires matching committed artifact')}
        const updated=store.transitionEvent(jobId,payload.runnerId,integer(payload.sequence),kind,JSON.stringify(request.body),text(payload.leaseId),text(payload.leaseNonce),payload.requestId,payload.nonce)
        if(kind==='heartbeat'){const issuedAt=new Date().toISOString(),template=validateJobSpec(object(JSON.parse(String(updated.spec_json)))),spec=EmpiricalJobSpecSchema.parse({...template,leaseId:updated.lease_id,runnerId:payload.runnerId,sequence:String(Number(updated.version)+1),nonce:updated.lease_nonce,issuedAt,expiresAt:updated.lease_expires_at,leaseExpiresAt:updated.lease_expires_at});return {accepted:true,jobSpec:signEnvelope(signer,spec,issuedAt)}}
        return {accepted:true}
      },['jobId','kind','leaseId','leaseNonce','data'])
    })
  }

  app.head('/api/empirical/runner/uploads/:hash',async(request,reply)=>{
    try{const uploadHash=validHash((request.params as {hash:string}).hash)
    const envelope=headerEnvelope(request)
    return await runnerGuard(store,{...request,body:envelope} as FastifyRequest,reply,requireMtls,adminFingerprints,'upload.head',{uploadHash},payload=>{
      store.transaction(()=>store.consumeOperation(payload.runnerId,payload.requestId,payload.nonce,integer(payload.sequence),'upload.head',uploadHash))
      const row=store.sqlite.prepare('SELECT expected_size,complete FROM empirical_uploads WHERE hash=? AND runner_id=?').get(uploadHash,payload.runnerId) as Row|undefined
      const contiguous=row?contiguousOffset(store,uploadHash):0
      reply.header('upload-offset',String(contiguous));reply.header('upload-complete',row?.complete?'true':'false');return reply.send()
    },['uploadHash'])}catch(error){return reply.code(401).send(problem(error))}
  })

  app.post('/api/empirical/runner/uploads/:hash',async(request,reply)=>{
    const uploadHash=validHash((request.params as {hash:string}).hash)
    return runnerGuard(store,request,reply,requireMtls,adminFingerprints,'upload.create',{uploadHash},payload=>{
      const size=integer(payload.totalSize);if(size<=0||size>artifactMaxBytes)throw new Error('upload total size out of bounds')
      const job=boundJob(store,payload.runnerId,text(payload.jobId),text(payload.leaseId),text(payload.leaseNonce))
      return store.transaction(()=>{
        store.consumeOperation(payload.runnerId,payload.requestId,payload.nonce,integer(payload.sequence),'upload.create',uploadHash,true)
        const used=store.sqlite.prepare('SELECT COALESCE(SUM(expected_size),0) total FROM empirical_uploads WHERE runner_id=? AND complete=0').get(payload.runnerId) as Row
        if(Number(used.total)+size>runnerQuota)throw new Error('runner upload quota exceeded')
        const existing=store.sqlite.prepare('SELECT * FROM empirical_uploads WHERE hash=?').get(uploadHash) as Row|undefined
        if(existing){if(existing.runner_id!==payload.runnerId||Number(existing.expected_size)!==size||existing.job_id!==job.id)throw new Error('upload owner/size/job conflict');return {hash:uploadHash,idempotent:true}}
        store.sqlite.prepare('INSERT INTO empirical_uploads VALUES(?,?,?,?,?,?,0,?,?)').run(uploadHash,payload.runnerId,String(job.id),text(payload.leaseId),text(payload.leaseNonce),size,new Date().toISOString(),new Date().toISOString())
        return {hash:uploadHash,created:true}
      })
    },['uploadHash','jobId','leaseId','leaseNonce','totalSize'])
  })

  app.patch('/api/empirical/runner/uploads/:hash',async(request,reply)=>{
    try{const uploadHash=validHash((request.params as {hash:string}).hash),envelope=headerEnvelope(request)
    const body=Buffer.isBuffer(request.body)?request.body:Buffer.alloc(0)
    return runnerGuard(store,{...request,body:envelope} as FastifyRequest,reply,requireMtls,adminFingerprints,'upload.chunk',{uploadHash},payload=>{
      const offset=integer(payload.offset),length=integer(payload.length),chunkHash=validHash(text(payload.chunkHash)),totalSize=integer(payload.totalSize)
      if(body.length===0||body.length!==length||length>chunkMax||hash(body)!==chunkHash)throw new Error('chunk length/hash invalid')
      const upload=store.sqlite.prepare('SELECT * FROM empirical_uploads WHERE hash=?').get(uploadHash) as Row|undefined
      if(!upload||upload.runner_id!==payload.runnerId||Number(upload.expected_size)!==totalSize||upload.complete)throw new Error('upload owner/size/state mismatch')
      if(offset+length>totalSize)throw new Error('chunk exceeds upload')
      boundJob(store,payload.runnerId,text(upload.job_id),text(payload.leaseId),text(payload.leaseNonce))
      const path=join(chunks,uploadHash,`${offset}-${chunkHash}.chunk`),staged=`${path}.${payload.requestId}.staging`
      const reserved=store.transaction(()=>{
        store.consumeOperation(payload.runnerId,payload.requestId,payload.nonce,integer(payload.sequence),'upload.chunk',uploadHash,true)
        const existing=store.sqlite.prepare('SELECT * FROM empirical_upload_chunks WHERE upload_hash=? AND offset=?').get(uploadHash,offset) as Row|undefined
        if(existing&&(existing.chunk_hash!==chunkHash||Number(existing.size)!==length))throw new Error('concurrent offset conflict')
        if(existing){if(!existing.ready)throw new Error('chunk offset is being staged');return false}
        store.sqlite.prepare('INSERT INTO empirical_upload_chunks(upload_hash,offset,size,chunk_hash,path,created_at,ready) VALUES(?,?,?,?,?,?,0)').run(uploadHash,offset,length,chunkHash,path,new Date().toISOString())
        return true
      })
      if(reserved){try{mkdirSync(dirname(path),{recursive:true});const fd=openSync(staged,'wx',0o600);try{writeAll(fd,body);fsyncSync(fd)}finally{closeSync(fd)}renameSync(staged,path);fsyncDir(dirname(path));store.transaction(()=>{if(store.sqlite.prepare('UPDATE empirical_upload_chunks SET ready=1 WHERE upload_hash=? AND offset=? AND ready=0').run(uploadHash,offset).changes!==1)throw new Error('chunk reservation lost')})}catch(error){rmSync(staged,{force:true});rmSync(path,{force:true});store.transaction(()=>store.sqlite.prepare('DELETE FROM empirical_upload_chunks WHERE upload_hash=? AND offset=? AND ready=0').run(uploadHash,offset));throw error}}
      else if(!existsSync(path)||statSync(path).size!==length||hash(readFileSync(path))!==chunkHash)throw new Error('chunk reservation incomplete')
      return reply.header('upload-offset',String(contiguousOffset(store,uploadHash))).send()
    },['uploadHash','leaseId','leaseNonce','totalSize','offset','length','chunkHash'])}catch(error){return reply.code(401).send(problem(error))}
  })

  app.post('/api/empirical/runner/uploads/:hash/complete',async(request,reply)=>{
    const uploadHash=validHash((request.params as {hash:string}).hash)
    return runnerGuard(store,request,reply,requireMtls,adminFingerprints,'upload.complete',{uploadHash},payload=>{
      const signedIndex=payload.signedIndex as Envelope,upload=store.sqlite.prepare('SELECT * FROM empirical_uploads WHERE hash=?').get(uploadHash) as Row|undefined
      if(!upload||upload.runner_id!==payload.runnerId)throw new Error('upload owner mismatch')
      const job=boundJob(store,payload.runnerId,text(payload.jobId),text(payload.leaseId),text(payload.leaseNonce))
      if(upload.job_id!==payload.jobId||upload.lease_id!==payload.leaseId||upload.lease_nonce!==payload.leaseNonce)throw new Error('upload lease binding mismatch')
      const runner=store.runner(payload.runnerId)!;verifyEnvelope(signedIndex,String(runner.public_key),String(runner.key_id))
      if(upload.complete){const artifact=store.sqlite.prepare('SELECT * FROM empirical_artifacts WHERE hash=?').get(uploadHash) as Row|undefined;if(!artifact||artifact.runner_id!==payload.runnerId||canonicalJson(signedIndex.payload as JsonValue)!==String(artifact.index_json))throw new Error('completed artifact owner/index mismatch');return {hash:uploadHash,complete:true,idempotent:true}}
      const rows=store.sqlite.prepare('SELECT * FROM empirical_upload_chunks WHERE upload_hash=? AND ready=1 ORDER BY offset').all(uploadHash) as Row[]
      let expected=0;for(const row of rows){if(Number(row.offset)!==expected)throw new Error('non-contiguous upload');expected+=Number(row.size)}
      if(expected!==Number(upload.expected_size))throw new Error('incomplete upload')
      const target=join(artifacts,uploadHash)
      let bytes:Buffer
      if(existsSync(target)){bytes=readFileSync(target)}
      else{const staged=join(artifacts,`${uploadHash}.${process.pid}.${payload.requestId}.staging`),fd=openSync(staged,'wx',0o600)
        try{for(const row of rows){const chunk=readFileSync(String(row.path));if(chunk.length!==Number(row.size)||hash(chunk)!==row.chunk_hash)throw new Error('chunk integrity mismatch');writeAll(fd,chunk)}fsyncSync(fd)}finally{closeSync(fd)}
        bytes=readFileSync(staged);if(bytes.length!==Number(upload.expected_size)||hash(bytes)!==uploadHash)throw new Error('assembled hash/size mismatch')
        renameSync(staged,target);fsyncDir(artifacts)
      }
      if(bytes.length!==Number(upload.expected_size)||hash(bytes)!==uploadHash)throw new Error('assembled hash/size mismatch')
      const spec=validateJobSpec(object(JSON.parse(String(job.spec_json))))
      const manifest=store.sqlite.prepare('SELECT envelope_json FROM empirical_manifests WHERE runner_id=? AND expires_at>? ORDER BY sequence DESC LIMIT 1').get(payload.runnerId,new Date().toISOString()) as Row|undefined
      if(!manifest)throw new Error('authoritative capability manifest unavailable')
      const manifestPayload=object(object((JSON.parse(String(manifest.envelope_json)) as Envelope).payload).manifest)
      const index=verifyRawBundle(bytes,signedIndex,payload.runnerId,text(payload.jobId),String(runner.public_key),String(runner.key_id),spec,manifestPayload)
      store.transaction(()=>{
        store.consumeOperation(payload.runnerId,payload.requestId,payload.nonce,integer(payload.sequence),'upload.complete',uploadHash,true)
        store.sqlite.prepare('INSERT INTO empirical_artifacts VALUES(?,?,?,?,?,?,?)').run(uploadHash,payload.runnerId,text(payload.jobId),bytes.length,target,canonicalJson(index as JsonValue),new Date().toISOString())
        store.sqlite.prepare('UPDATE empirical_uploads SET complete=1,updated_at=? WHERE hash=? AND complete=0').run(new Date().toISOString(),uploadHash)
        store.sqlite.prepare('UPDATE empirical_jobs SET artifact_id=?,version=version+1,updated_at=? WHERE id=? AND runner_id=? AND lease_id=?').run(uploadHash,new Date().toISOString(),text(payload.jobId),payload.runnerId,text(payload.leaseId))
      })
      return reply.code(201).send({hash:uploadHash,complete:true})
    },['uploadHash','jobId','leaseId','leaseNonce','signedIndex'])
  })

  app.get('/api/empirical/artifacts/:hash',async(request,reply)=>store.sqlite.prepare('SELECT hash,runner_id,job_id,size,index_json,created_at FROM empirical_artifacts WHERE hash=?').get(validHash((request.params as {hash:string}).hash))??reply.code(404).send({error:'artifact_not_found'}))
}

async function runnerGuard(store:EmpiricalStore,request:FastifyRequest,reply:any,requireMtls:boolean,adminFingerprints:readonly string[],operation:string,bindings:Record<string,string>,handler:(payload:Operation)=>unknown,extra:string[]=[],allowPending=false):Promise<unknown>{
  try{
    const envelope=request.body as Envelope<Operation>,payload=object(envelope?.payload) as Operation,runner=store.runner(text(payload.runnerId))
    if(!runner||(!allowPending&&runner.state!=='approved')||(allowPending&&!['pending','approved'].includes(String(runner.state)))||Date.parse(String(runner.credential_expires_at))<=Date.now())throw new Error('runner not approved')
    if(requireMtls&&certificateRole(peerFingerprint(request),adminFingerprints,String(runner.cert_fingerprint??''))!=='runner')throw new Error('runner mTLS identity mismatch')
    verifyEnvelope(envelope,String(runner.public_key),String(runner.key_id))
    if(payload.operation!==operation||payload.keyId!==runner.key_id)throw new Error('operation domain/identity mismatch')
    for(const [key,value] of Object.entries(bindings))if(payload[key]!==value)throw new Error(`signed ${key} differs from route`)
    const allowed=[...new Set([...BASE_KEYS,...Object.keys(bindings),...extra])].sort()
    if(Object.keys(payload).sort().join(',')!==allowed.join(','))throw new Error('operation payload has missing/unknown fields')
    if(!safeRequestId(payload.requestId)||!canonicalNonce(payload.nonce)||!/^[1-9]\d*$/.test(payload.sequence))throw new Error('invalid operation replay fields')
    const timestamp=Date.parse(payload.timestamp);if(!Number.isFinite(timestamp)||Math.abs(Date.now()-timestamp)>FRESH_MS||envelope.signedAt!==payload.timestamp)throw new Error('stale operation timestamp')
    return await handler(payload)
  }catch(error){try{store.transaction(()=>store.audit('unknown',operation,'failure','request',String((request as any).id??''),{error:error instanceof Error?error.message:'rejected'}))}catch{}return reply.code(401).send(problem(error))}
}
function verifyEnvelope(envelope:Envelope,publicKey:string,keyId:string):void{
  if(!envelope||envelope.algorithm!=='Ed25519'||envelope.keyId!==keyId)throw new Error('signature metadata mismatch')
  const key=createPublicKey({key:Buffer.from(decodeCanonicalBase64(publicKey)),format:'der',type:'spki'})
  if(key.asymmetricKeyType!=='ed25519')throw new Error('non-Ed25519 key')
  const signature=Buffer.from(decodeCanonicalBase64(envelope.signature,64))
  const message=Buffer.from(canonicalJson({protected:{algorithm:envelope.algorithm,keyId:envelope.keyId,signedAt:envelope.signedAt},payload:envelope.payload} as JsonValue))
  if(!verify(null,message,key,signature))throw new Error('invalid signature')
}
export function verifyEmpiricalEnvelope(envelope:unknown,publicKey:string,keyId:string):void{verifyEnvelope(envelope as Envelope,publicKey,keyId)}
function signEnvelope(key:KeyObject,payload:Record<string,unknown>,signedAt=new Date().toISOString()):Envelope{
  const keyId=`orchestrator:${hash(createPublicKey(key).export({format:'der',type:'spki'}))}`,value={algorithm:'Ed25519' as const,keyId,payload,signedAt}
  const message=Buffer.from(canonicalJson({protected:{algorithm:value.algorithm,keyId,signedAt:value.signedAt},payload} as JsonValue))
  return {...value,signature:sign(null,message,key).toString('base64')}
}
function validateIdentity(value:Record<string,unknown>):{runnerId:string;keyId:string;publicKey:string}{
  const publicKey=canonicalPublicKey(text(value.publicKey)),der=Buffer.from(publicKey,'base64'),digest=hash(der)
  const expected={runnerId:`runner:${digest}`,keyId:`ed25519:${digest}`,publicKey}
  if(value.runnerId!==expected.runnerId||value.keyId!==expected.keyId)throw new Error('identity IDs do not match canonical SPKI')
  if(Object.keys(value).sort().join(',')!=='issuedAt,keyId,publicKey,runnerId'||!Number.isFinite(Date.parse(text(value.issuedAt))))throw new Error('invalid identity shape')
  return expected
}
function canonicalPublicKey(value:string):string{const der=Buffer.from(decodeCanonicalBase64(value));const key=createPublicKey({key:der,format:'der',type:'spki'});if(key.asymmetricKeyType!=='ed25519'||!key.export({format:'der',type:'spki'}).equals(der))throw new Error('noncanonical/non-Ed25519 SPKI');return der.toString('base64')}
function validateManifest(value:Record<string,unknown>):void{
  const required=['caches','clock','container','cpu','energy','expiresAt','firmware','frequency','host','memory','observedAt','pmu','runnerId','schemaVersion','sequence','thermal']
  if(Object.keys(value).sort().join(',')!==required.join(',')||value.schemaVersion!=='1'||!/^runner:[a-f0-9]{64}$/.test(text(value.runnerId)))throw new Error('invalid manifest schema')
  for(const key of ['caches','clock','container','energy','firmware','frequency','memory','pmu','thermal'])validateAvailability(value[key])
  for(const nested of Object.values(object(value.host)))validateAvailability(nested)
  for(const nested of Object.values(object(value.cpu)))validateAvailability(nested)
  const serialized=canonicalJson(value as JsonValue);if(Buffer.byteLength(serialized)>1024*1024)throw new Error('manifest too large')
}
function validateAvailability(value:unknown):void{const item=object(value);if(!['supported','unsupported','permission-denied','probe-failed'].includes(text(item.status)))throw new Error('invalid capability status');if(item.status==='supported'){if(!('value'in item))throw new Error('supported capability lacks value')}else if(typeof item.reason!=='string'||item.reason.length<1||item.reason.length>4096)throw new Error('invalid capability reason')}
function validateJobSpec(value:Record<string,unknown>):EmpiricalJobTemplate{
  const spec=EmpiricalJobTemplateSchema.parse(value)
  if(spec.testOnly!==false)throw new Error('production job must set testOnly=false')
  safePathId(spec.jobId)
  return spec
}
export function verifyRawBundle(bytes:Buffer,signedIndex:Envelope,runnerId:string,jobId:string,publicKey:string,keyId:string,spec:EmpiricalJobTemplate,manifest:Record<string,unknown>):Record<string,unknown>{
  if(bytes.at(-1)!==0x0a)throw new Error('torn bundle')
  const lines=bytes.toString('utf8').split('\n').slice(0,-1);if(lines.length<3||lines.some(line=>!line))throw new Error('malformed bundle')
  const header=object(JSON.parse(lines[0]!)),index=object(JSON.parse(lines.at(-1)!))
  if(header.kind!=='header'||header.schemaVersion!=='1'||header.testOnly!==false||header.runnerId!==runnerId||header.jobId!==jobId)throw new Error('bundle header binding mismatch')
  const bodyRecords=lines.slice(1,-1).map(line=>object(JSON.parse(line))),scheduleRecords=bodyRecords.filter(record=>record.kind==='schedule')
  if(scheduleRecords.length!==1||bodyRecords[0]!==scheduleRecords[0])throw new Error('bundle requires exactly one leading signed schedule')
  const schedule=scheduleRecords[0]!,entries=Array.isArray(schedule.entries)?schedule.entries.map(object):[]
  const signed=schedule.signed as Envelope;verifyEnvelope(signed,publicKey,keyId)
  const authoritativeSchedule=buildEmpiricalSchedule(spec.seed,spec.repetitions,spec.warmups)
  if(canonicalJson(entries as JsonValue)!==canonicalJson(authoritativeSchedule.entries as unknown as JsonValue)||canonicalJson(schedule.protocol as JsonValue)!==canonicalJson(authoritativeSchedule.protocol as unknown as JsonValue)||canonicalJson(signed.payload as JsonValue)!==canonicalJson({jobId:schedule.jobId,seed:schedule.seed,entries:schedule.entries,protocol:schedule.protocol} as JsonValue)||schedule.jobId!==jobId||schedule.seed!==spec.seed)throw new Error('signed schedule/protocol differs from shared authoritative schedule')
  const raw=bodyRecords.filter(record=>record.kind==='raw-run')
  for(const record of raw)validateRawEvidence(record,spec)
  const scheduledRaw=raw.filter(record=>Number(record.ordinal)>=0)
  const negativeRaw=raw.filter(record=>Number(record.ordinal)<0),overhead=negativeRaw.filter(record=>record.ordinal===-100)
  const pilots=negativeRaw.filter(record=>record.phase==='pilot')
  if(overhead.length!==1||canonicalJson(selectProtocolFields(overhead[0]!) as JsonValue)!==canonicalJson({phase:'idle',arm:'B',block:-1,ordinal:-100,pairId:'instrumentation-overhead'} as JsonValue))throw new Error('instrumentation overhead differs from signed protocol')
  if(pilots.length<1||pilots.length>8||pilots.some((record,index)=>canonicalJson(selectProtocolFields(record) as JsonValue)!==canonicalJson({phase:'pilot',arm:'A',block:-1,ordinal:-1-index,pairId:`pilot-${index}`} as JsonValue)))throw new Error('pilot records differ from signed protocol')
  if(negativeRaw.length!==overhead.length+pilots.length)throw new Error('unscheduled negative-ordinal raw record')
  if(scheduledRaw.length!==entries.length)throw new Error('raw schedule cardinality mismatch')
  const seen=new Set<number>();for(let i=0;i<entries.length;i++){const entry=entries[i]!,record=scheduledRaw[i]!;const ordinal=integer(record.ordinal);if(seen.has(ordinal)||record.phase!==entry.phase||record.arm!==entry.arm||record.pairId!==entry.pairId||ordinal!==entry.ordinal)throw new Error('raw schedule reconciliation mismatch');seen.add(ordinal)}
  validateManifestForJob(manifest,spec)
  const indexLine=Buffer.from(`${lines.at(-1)}\n`),body=bytes.subarray(0,bytes.length-indexLine.length)
  if(index.kind!=='index'||index.schemaVersion!=='1'||index.runnerId!==runnerId||index.jobId!==jobId||index.sha256!==hash(body)||index.byteSize!==String(body.length)||index.recordCount!==lines.length-2)throw new Error('bundle index mismatch')
  if(!Array.isArray(index.artifactIdentities)||index.artifactIdentities.some(item=>!artifactHash(item)))throw new Error('invalid artifact index references')
  if(canonicalJson(signedIndex.payload as JsonValue)!==canonicalJson(index as JsonValue))throw new Error('signed index differs from body index')
  return index
}
function selectProtocolFields(record:Record<string,unknown>):Record<string,unknown>{return{phase:record.phase,arm:record.arm,block:record.block,ordinal:record.ordinal,pairId:record.pairId}}
function validateRawEvidence(record:Record<string,unknown>,spec:EmpiricalJobTemplate):void{
  if(typeof record.valid!=='boolean'||!Array.isArray(record.validityReasons)||!/^(0|[1-9]\d*)$/.test(text(record.monotonicDurationNs))||!Number.isSafeInteger(record.ordinal)||typeof record.pairId!=='string'||typeof record.timedOut!=='boolean'||!Array.isArray(record.adapterStatus))throw new Error('invalid raw record')
  if(record.contextSwitches!==null)object(record.contextSwitches);if(record.faults!==null)object(record.faults);object(record.clock);const oracle=object(record.oracle),affinity=object(record.affinity)
  if(record.valid&&(oracle.passed!==true||record.timedOut||canonicalJson(affinity.requested as JsonValue)!==canonicalJson(affinity.effective as JsonValue)))throw new Error('valid raw record lacks oracle/affinity evidence')
  for(const adapter of spec.adapters){const policy=parseEmpiricalAdapter(adapter),status=(record.adapterStatus as unknown[]).map(object).find(item=>item.adapter===policy.name);if(!status||status.required!==policy.required||(record.valid&&policy.required&&status.supported!==true))throw new Error('raw adapter policy mismatch')}
  if(record.valid&&spec.adapters.some(adapter=>{const policy=parseEmpiricalAdapter(adapter);return policy.required&&policy.name==='linux-perf'})&&(!Array.isArray(record.perf)||record.perf.length===0))throw new Error('valid raw record lacks perf evidence')
  if(record.valid&&spec.adapters.some(adapter=>{const policy=parseEmpiricalAdapter(adapter);return policy.required&&policy.name.startsWith('rapl')})&&(!Array.isArray(record.energy)||!record.energy.map(object).some(item=>item.supported===true)))throw new Error('valid raw record lacks energy evidence')
  if(record.valid&&Object.keys(spec.controls).some(key=>key!=='affinity')&&(Object.keys(object(record.controlsBefore)).length===0||Object.keys(object(record.controlsAfter)).length===0))throw new Error('valid raw record lacks control evidence')
}
function validateManifestForJob(manifest:Record<string,unknown>,spec:EmpiricalJobTemplate):void{
  validateManifest(manifest);const host=object(manifest.host),os=object(host.os),arch=object(host.arch),abi=object(host.abi)
  if(os.status!=='supported'||object(os.value).platform!==spec.target.os||arch.status!=='supported'||canonicalIsa(String(arch.value))!==canonicalIsa(spec.target.isa)||abi.status!=='supported'||abi.value!==spec.target.abi)throw new Error('manifest host target mismatch')
  if(object(manifest.clock).status!=='supported')throw new Error('manifest clock unavailable')
  if(spec.adapters.some(adapter=>{const policy=parseEmpiricalAdapter(adapter);return policy.required&&policy.name==='linux-perf'})&&object(manifest.pmu).status!=='supported')throw new Error('manifest PMU unavailable')
  if(spec.adapters.some(adapter=>{const policy=parseEmpiricalAdapter(adapter);return policy.required&&policy.name.startsWith('rapl')})&&object(manifest.energy).status!=='supported')throw new Error('manifest energy unavailable')
}
function canonicalIsa(value:string):string{return value==='x64'||value==='x86_64'?'x86_64':value==='arm64'||value==='aarch64'?'aarch64':value}
function boundJob(store:EmpiricalStore,runnerId:string,jobId:string,leaseId:string,leaseNonce:string):Row{const job=store.sqlite.prepare('SELECT * FROM empirical_jobs WHERE id=?').get(jobId) as Row|undefined;if(!job||job.runner_id!==runnerId||job.lease_id!==leaseId||job.lease_nonce!==leaseNonce||Date.parse(String(job.lease_expires_at))<=Date.now())throw new Error('job lease binding invalid');return job}
function contiguousOffset(store:EmpiricalStore,uploadHash:string):number{const rows=store.sqlite.prepare('SELECT offset,size FROM empirical_upload_chunks WHERE upload_hash=? AND ready=1 ORDER BY offset').all(uploadHash) as Row[];let value=0;for(const row of rows){if(Number(row.offset)!==value)break;value+=Number(row.size)}return value}
function headerEnvelope(request:FastifyRequest):Envelope<Operation>{const raw=request.headers['x-runner-operation'];if(typeof raw!=='string')throw new Error('signed operation header required');return JSON.parse(Buffer.from(decodeCanonicalBase64(raw)).toString('utf8')) as Envelope<Operation>}
function peerFingerprint(request:FastifyRequest):string|null{const socket=request.socket as any;const cert=typeof socket.getPeerCertificate==='function'?socket.getPeerCertificate():null;return cert?.fingerprint256?.replaceAll(':','').toLowerCase()??null}
function loadSigner(path:string):KeyObject{if(existsSync(path)){const key=createPrivateKey({key:readFileSync(path),format:'der',type:'pkcs8'});if(key.asymmetricKeyType!=='ed25519')throw new Error('orchestrator key is not Ed25519');return key}const key=generateKeyPairSync('ed25519').privateKey;mkdirSync(dirname(path),{recursive:true});writeFileSync(path,key.export({format:'der',type:'pkcs8'}),{flag:'wx',mode:0o600});return key}
function writeAll(fd:number,bytes:Buffer):void{let offset=0;while(offset<bytes.length){const count=writeSync(fd,bytes,offset,bytes.length-offset);if(count<=0)throw new Error('short write');offset+=count}}
function fsyncDir(path:string):void{try{const fd=openSync(path,'r');fsyncSync(fd);closeSync(fd)}catch{/* Windows directory flush is unavailable. */}}
function guard(reply:any,operation:()=>unknown,store:EmpiricalStore,action:string):unknown{try{return operation()}catch(error){try{store.transaction(()=>store.audit('unknown',action,'failure','request','rejected',{error:error instanceof Error?error.message:'rejected'}))}catch{}return reply.code(400).send(problem(error))}}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('object required');return value as Record<string,unknown>}
function text(value:unknown):string{if(typeof value!=='string'||!value)throw new Error('string required');return value}
function integer(value:unknown,fallback?:number):number{if(value===undefined&&fallback!==undefined)return fallback;const number=Number(value);if(!Number.isSafeInteger(number)||number<0)throw new Error('integer required');return number}
function validHash(value:string):string{if(!artifactHash(value))throw new Error('invalid hash');return value}
function artifactHash(value:unknown):boolean{return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)}
function canonicalNonce(value:unknown):boolean{try{return typeof value==='string'&&decodeCanonicalBase64(value,32).length===32}catch{return false}}
function safeRequestId(value:unknown):boolean{return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)}
function safePathId(value:string):void{if(!safeRequestId(value)||/[. ]$/.test(value)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value))throw new Error('unsafe ID')}
function problem(error:unknown):{error:string}{return{error:error instanceof Error?error.message:String(error)}}
