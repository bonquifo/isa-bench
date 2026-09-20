#!/usr/bin/env node
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { checkServerIdentity } from 'node:tls'
import { inventoryCapabilities, inventoryCapabilitiesWithHelper } from './capabilities.js'
import { CredentialFileStore, Identity, OwnerOnlyFileKeyStore, signOperation, verifySigned } from './identity.js'
import { MeasurementHelperClient } from './helper-client.js'
import { LeaseSession, SequenceGuard, verifyJobSpec } from './protocol.js'
import { MeasurementRunner } from './measurement.js'
import { RawBundleWriter, verifyBundle } from './bundle.js'
import { uploadResumable, type UploadTransport } from './upload.js'
import { commitArtifactBeforeFinish } from './lifecycle.js'
import type { CapabilityManifest, CorpusEligibility, JobSpec, RawRunRecord, RunnerCredential, Signed } from './types.js'

const commands = new Set(['doctor', 'identity', 'enroll', 'capabilities', 'lease', 'run', 'bundle', 'upload'])

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (!command || !commands.has(command)) {
    throw new Error('usage: isa-empirical-runner doctor|identity|enroll|capabilities|lease|run|bundle|upload')
  }
  const state = process.env.ISA_SIM_RUNNER_STATE ?? join(homedir(), '.isa-sim-runner')
  const identity = await Identity.loadOrCreate(new OwnerOnlyFileKeyStore(join(state, 'identity.pk8')))
  switch (command) {
    case 'doctor':
      output({
        runnerId: identity.value.runnerId, platform: process.platform, arch: process.arch,
        node: process.version, measurementsRun: false,
        notes: ['inventory only', 'hardware permissions remain unknown until probed by helper'],
      })
      break
    case 'identity':
      output(identity.value)
      break
    case 'capabilities':
      {
      const publishing=args.includes('--publish'),base=option(args,'--url')
      if(publishing)await ensureApproved(state,identity,required(args,'--url'))
      const sequence=BigInt(option(args,'--sequence')??(publishing?String(readSequence(state)+1):'1')),helperPath=option(args,'--helper')
      const manifest=helperPath
        ? await inventoryCapabilitiesWithHelper(identity,sequence,new MeasurementHelperClient(helperPath,required(args,'--helper-sha')))
        : inventoryCapabilities(identity,sequence)
      if(publishing) {
        output(await postJson(endpoint(base!,'/api/empirical/runner/manifests'),operation(identity,state,'manifest.publish',{manifest:manifest.payload},Number(sequence))))
      } else output(manifest)
      break
      }
    case 'enroll':
      {
      const base=required(args,'--url')
      const challenge=await postJson(endpoint(base,'/api/empirical/enrollment/challenges'),{tokenId:required(args,'--token-id'),token:required(args,'--token'),identity:identity.value}) as {id:string;nonce:string}
      const enrolled = await postJson(endpoint(base,'/api/empirical/enrollment/complete'),identity.sign({challengeId:challenge.id,nonce:challenge.nonce})) as { orchestratorPublicKey: string; credential: Signed<Record<string, unknown>> }
      if (!enrolled.credential || !verifySigned(enrolled.credential, enrolled.orchestratorPublicKey) ||
          enrolled.credential.payload.runnerId !== identity.value.runnerId ||
          enrolled.credential.payload.keyId !== identity.value.keyId) throw new Error('invalid orchestrator credential')
      new CredentialFileStore(join(state, 'credential.json')).save(enrolled)
      output(enrolled)
      break
      }
    case 'lease':
      {
      await new MeasurementHelperClient(required(args,'--helper'),required(args,'--helper-sha'),30_000,undefined,resolve(state,'locks')).request({operation:'recover-controls'})
      await ensureApproved(state,identity,required(args,'--url'))
      const leased=await postJson(endpoint(required(args,'--url'),'/api/empirical/runner/jobs/lease'),operation(identity,state,'job.lease',{}))
      if(leased){writeAtomic(join(state,'lease.json'),leased);output(leased)}
      break
      }
    case 'run':
      if (!args.includes('--real-job')) throw new Error('run requires --real-job and an orchestrator-issued JobSpec')
      {
      await ensureApproved(state,identity,required(args,'--url'))
      const stored=new CredentialFileStore(join(state,'credential.json')).load()!
      const envelope=readJson<Signed<JobSpec>>(required(args,'--job'))
      const job=verifyJobSpec(envelope,stored.orchestratorPublicKey,identity.value.runnerId,new SequenceGuard())
      if(job.testOnly)throw new Error('real execution rejects testOnly JobSpec')
      const corpus=readJson<CorpusEligibility>(required(args,'--corpus')),capabilities=readJson<Signed<CapabilityManifest>>(required(args,'--capabilities'))
      const helper=new MeasurementHelperClient(required(args,'--helper'),required(args,'--helper-sha'),60_000,dirname(resolve(corpus.binaryPath)),resolve(state,'locks'))
      await helper.request({operation:'recover-controls'})
      const session=new LeaseSession(job,identity,BigInt(readSequence(state)))
      const base=required(args,'--url')
      await postJson(endpoint(base,`/api/empirical/runner/jobs/${job.jobId}/accept`),leaseOperation(session,state,'accept'))
      await postJson(endpoint(base,`/api/empirical/runner/jobs/${job.jobId}/start`),leaseOperation(session,state,'start'))
      const bundlePath=join(state,'bundles',`${job.jobId}.jsonl.partial`)
      const header=existsSync(bundlePath)?JSON.parse(readFileSync(bundlePath,'utf8').split('\n')[0]!) as {kind:'header';schemaVersion:'1';jobId:string;runnerId:string;testOnly:boolean;createdAt:string}:{kind:'header' as const,schemaVersion:'1' as const,jobId:job.jobId,runnerId:identity.value.runnerId,testOnly:false,createdAt:new Date().toISOString()}
      const writer=new RawBundleWriter(bundlePath,header)
      const recovered=writer.recoveredRecords(),pilot=[...recovered].reverse().find(record=>record.kind==='raw-run'&&record.phase==='pilot'&&record.valid)
      const resume=pilot&&pilot.kind==='raw-run'?{innerIterations:pilot.oracle.iterations,matchedDurationNs:pilot.monotonicDurationNs,completedOrdinals:recovered.filter((record):record is RawRunRecord=>record.kind==='raw-run'&&record.ordinal>=0).map(record=>record.ordinal),schedulePresent:true as const}:undefined
      const renewalSequences=new SequenceGuard();renewalSequences.accept(`job:${job.jobId}`,job.sequence)
      let heartbeatFailure:unknown,heartbeatBusy=false,uploading=false,lastHeartbeat=0
      const heartbeatNow=async()=>{if(heartbeatBusy)return;heartbeatBusy=true;try{const value=await postJson(endpoint(base,`/api/empirical/runner/jobs/${job.jobId}/heartbeat`),leaseOperation(session,state,'heartbeat'));const response=value as {jobSpec?:Signed<JobSpec>};if(response.jobSpec)session.renew(response.jobSpec,stored.orchestratorPublicKey,renewalSequences);lastHeartbeat=Date.now()}finally{heartbeatBusy=false}}
      const heartbeat=setInterval(()=>{if(heartbeatBusy||uploading)return;void heartbeatNow().catch(error=>{heartbeatFailure=error})},20_000)
      try{
        const result=await new MeasurementRunner(helper).run(job,{allowRealJob:true,corpus,capabilities,lockRoot:join(state,'locks'),identity,bundleRecord:record=>writer.append(record),temperature:async()=>null,sleep:ms=>new Promise(resolveSleep=>setTimeout(resolveSleep,ms)),resume,existingSchedule:recovered.some(record=>record.kind==='schedule')})
        if(heartbeatFailure)throw heartbeatFailure
        await heartbeatNow();uploading=true
        const finalized=writer.finalize(identity,[job.binary.sha256])
        const artifactHash=await commitArtifactBeforeFinish(finalized.path,uploadTransport(base,identity,state,job,finalized.signature,async()=>{if(Date.now()-lastHeartbeat>=20_000)await heartbeatNow()}),async hash=>{uploading=false;await postJson(endpoint(base,`/api/empirical/runner/jobs/${job.jobId}/finish`),leaseOperation(session,state,'finish',{artifactHash:hash}))})
        uploading=false
        output({...result,bundle:finalized.path,artifactHash})
      }catch(error){uploading=false;try{await postJson(endpoint(base,`/api/empirical/runner/jobs/${job.jobId}/fail`),leaseOperation(session,state,'fail',{reason:error instanceof Error?error.message:String(error)}))}catch{}throw error}
      finally{clearInterval(heartbeat)}
      break
      }
    case 'bundle':
      output(verifyBundle(required(args,'--path'),!args.includes('--allow-test-only')))
      break
    case 'upload':
      {
      await ensureApproved(state,identity,required(args,'--url'))
      const bundle=resolve(required(args,'--path')),job=readJson<Signed<JobSpec>>(required(args,'--job')).payload
      const signature=readJson<Signed<unknown>>(`${bundle}.signature.json`),base=required(args,'--url')
      verifyBundle(bundle,true,{runnerId:identity.value.runnerId,jobId:job.jobId,publicKey:identity.value.publicKey})
      const transport=uploadTransport(base,identity,state,job,signature)
      output({hash:await uploadResumable(bundle,transport)})
      break
      }
  }
}

function required(args: string[], name: string): string {
  const value = option(args, name)
  if (!value) throw new Error(`${name} is required`)
  return value
}
function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
function endpoint(base:string,path:string):string{return new URL(path,base.endsWith('/')?base:`${base}/`).toString()}
function readJson<T>(path:string):T{return JSON.parse(readFileSync(path,'utf8')) as T}
function writeAtomic(path:string,value:unknown):void{const temporary=`${path}.${process.pid}.tmp`;writeFileSync(temporary,JSON.stringify(value),{flag:'wx',mode:0o600});renameSync(temporary,path)}
function readSequence(state:string):number{try{const value=Number(readFileSync(join(state,'sequence'),'utf8'));return Number.isSafeInteger(value)&&value>=0?value:0}catch{return 0}}
function writeSequence(state:string,value:number):void{writeAtomic(join(state,'sequence'),String(value))}
function operation(identity:Identity,state:string,name:string,extra:Record<string,unknown>,forcedSequence?:number):Signed<Record<string,unknown>>{
  const current=readSequence(state),sequence=forcedSequence??current+1
  if(sequence<=current)throw new Error('operation sequence rollback')
  const timestamp=new Date().toISOString(),payload={operation:name,runnerId:identity.value.runnerId,keyId:identity.value.keyId,requestId:randomUUID(),sequence:String(sequence),nonce:randomBytes(32).toString('base64'),timestamp,...extra}
  const signed=signOperation(identity,payload,new Date(timestamp));writeSequence(state,sequence);return signed
}
function leaseOperation(session:LeaseSession,state:string,kind:Parameters<LeaseSession['event']>[0],data:Record<string,unknown>={}):Signed<import('./types.js').LeaseEvent>{session.syncSequence(BigInt(readSequence(state)));const event=session.event(kind,data);writeSequence(state,Number(session.currentSequence));return event}
function approvedCredential(state:string,identity:Identity):{orchestratorPublicKey:string;credential:Signed<RunnerCredential>}{
  const stored=new CredentialFileStore(join(state,'credential.json')).load()
  if(!stored||!verifySigned(stored.credential,stored.orchestratorPublicKey))throw new Error('valid runner credential unavailable')
  const credential=stored.credential as Signed<RunnerCredential>
  if(credential.payload.runnerId!==identity.value.runnerId||credential.payload.keyId!==identity.value.keyId||credential.payload.state!=='approved'||Date.parse(credential.payload.expiresAt)<=Date.now())throw new Error('runner credential is not approved/current')
  return {orchestratorPublicKey:stored.orchestratorPublicKey,credential}
}
async function ensureApproved(state:string,identity:Identity,base:string):Promise<void>{
  try{approvedCredential(state,identity);return}catch{}
  const refreshed=await postJson(endpoint(base,'/api/empirical/runner/credential'),operation(identity,state,'credential.get',{})) as {orchestratorPublicKey:string;credential:Signed<RunnerCredential>}
  const existing=new CredentialFileStore(join(state,'credential.json')).load()
  if(existing&&existing.orchestratorPublicKey!==refreshed.orchestratorPublicKey)throw new Error('orchestrator key pin changed')
  if(!verifySigned(refreshed.credential,refreshed.orchestratorPublicKey)||refreshed.credential.payload.state!=='approved')throw new Error('runner is not approved')
  new CredentialFileStore(join(state,'credential.json')).save(refreshed)
  approvedCredential(state,identity)
}
function uploadTransport(base:string,identity:Identity,state:string,job:JobSpec,signedIndex:Signed<unknown>,beforeRequest:()=>Promise<void>=async()=>{}):UploadTransport{
  const binding={jobId:job.jobId,leaseId:job.leaseId,leaseNonce:job.nonce}
  return {
    async head(hash){await beforeRequest();const signed=operation(identity,state,'upload.head',{uploadHash:hash});const response=await rawRequest(endpoint(base,`/api/empirical/runner/uploads/${hash}`),'HEAD',undefined,{'x-runner-operation':Buffer.from(JSON.stringify(signed)).toString('base64')});return{complete:response.headers.get('upload-complete')==='true',offset:Number(response.headers.get('upload-offset')??0)}},
    async create(hash,size){await beforeRequest();await postJson(endpoint(base,`/api/empirical/runner/uploads/${hash}`),operation(identity,state,'upload.create',{uploadHash:hash,...binding,totalSize:size}))},
    async patch(hash,offset,bytes,chunkHash,totalSize){await beforeRequest();const signed=operation(identity,state,'upload.chunk',{uploadHash:hash,leaseId:job.leaseId,leaseNonce:job.nonce,totalSize,offset,length:bytes.byteLength,chunkHash});const response=await rawRequest(endpoint(base,`/api/empirical/runner/uploads/${hash}`),'PATCH',bytes,{'content-type':'application/offset+octet-stream','x-runner-operation':Buffer.from(JSON.stringify(signed)).toString('base64')});return{offset:Number(response.headers.get('upload-offset'))}},
    async complete(hash){await beforeRequest();await postJson(endpoint(base,`/api/empirical/runner/uploads/${hash}/complete`),operation(identity,state,'upload.complete',{uploadHash:hash,...binding,signedIndex}))},
  }
}
async function rawRequest(url:string,method:string,body?:Uint8Array,headers:Record<string,string>={}):Promise<{headers:{get(name:string):string|null}}>{
  const parsed=new URL(url),loopback=parsed.hostname==='localhost'||parsed.hostname==='::1'||/^127\./.test(parsed.hostname)
  if(loopback){const response=await fetch(url,{method,headers,body:body?Buffer.from(body):undefined});if(!response.ok)throw new Error(`orchestrator returned HTTP ${response.status}`);return response}
  if(parsed.protocol!=='https:')throw new Error('non-loopback orchestrator URLs require HTTPS')
  const cert=process.env.ISA_SIM_RUNNER_TLS_CERT,key=process.env.ISA_SIM_RUNNER_TLS_KEY,ca=process.env.ISA_SIM_RUNNER_TLS_CA,pin=process.env.ISA_SIM_ORCHESTRATOR_CERT_SHA256
  if(!cert||!key||!ca||!pin)throw new Error('remote orchestrator requires CA, client certificate/key, and certificate pin')
  return new Promise((resolveRequest,reject)=>{
    const request=httpsRequest(parsed,{method,headers,cert:readFileSync(cert),key:readFileSync(key),ca:readFileSync(ca),checkServerIdentity(host,certificate){const error=checkServerIdentity(host,certificate);if(error)return error;return certificate.fingerprint256.replaceAll(':','').toLowerCase()===pin.replaceAll(':','').toLowerCase()?undefined:new Error('orchestrator certificate pin mismatch')}},response=>{
      const chunks:Buffer[]=[];response.on('data',(chunk:Buffer)=>chunks.push(chunk));response.on('end',()=>{if((response.statusCode??500)>=400)return reject(new Error(`orchestrator returned HTTP ${response.statusCode}: ${Buffer.concat(chunks).toString('utf8')}`));resolveRequest({headers:{get(name){const value=response.headers[name.toLowerCase()];return Array.isArray(value)?value[0]??null:value??null}}})})
    });request.on('error',reject);if(body)request.write(body);request.end()
  })
}
async function postJson(url: string, body: unknown): Promise<unknown> {
  const parsed = new URL(url)
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '::1' || /^127\./.test(parsed.hostname)
  if (!loopback && parsed.protocol !== 'https:') throw new Error('non-loopback orchestrator URLs require HTTPS')
  if (!loopback) {
    const cert = process.env.ISA_SIM_RUNNER_TLS_CERT, key = process.env.ISA_SIM_RUNNER_TLS_KEY
    const ca = process.env.ISA_SIM_RUNNER_TLS_CA, pin = process.env.ISA_SIM_ORCHESTRATOR_CERT_SHA256
    if (!cert || !key || !ca || !pin) throw new Error('remote orchestrator requires CA, client certificate/key, and certificate pin')
    return new Promise((resolve, reject) => {
      const request = httpsRequest(parsed, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        cert: readFileSync(cert), key: readFileSync(key), ca: readFileSync(ca),
        checkServerIdentity(host, certificate) {
          const error = checkServerIdentity(host, certificate)
          if (error) return error
          if (certificate.fingerprint256.replaceAll(':', '').toLowerCase() !== pin.replaceAll(':', '').toLowerCase()) {
            return new Error('orchestrator certificate pin mismatch')
          }
          return undefined
        },
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          if ((response.statusCode ?? 500) >= 400) return reject(new Error(`orchestrator returned HTTP ${response.statusCode}`))
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) } catch (error) { reject(error) }
        })
      })
      request.on('error', reject)
      request.end(JSON.stringify(body))
    })
  }
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`orchestrator returned HTTP ${response.status}`)
  return response.json()
}
function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
