import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Identity, sha256, verifySigned, type KeyStore } from '../src/index.js'

class MemoryStore implements KeyStore {
  value: Buffer | null = null
  async load(): Promise<Buffer | null> { return this.value }
  async store(_id: string, value: Buffer): Promise<void> { this.value = value }
}
const roots:string[]=[]
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})))

describe('CLI test-only lifecycle',()=>{
  it('enrolls, observes approval, publishes capabilities, leases, and refuses testOnly execution',async()=>{
    const orchestrator=await Identity.loadOrCreate(new MemoryStore())
    let runner:{runnerId:string;keyId:string;publicKey:string}|undefined
    const server=createServer(async(request,response)=>{
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):null
      let value:unknown
      if(request.url?.endsWith('/enrollment/challenges')){runner=body.identity;value={id:'challenge',nonce:Buffer.alloc(32,9).toString('base64')}}
      else if(request.url?.endsWith('/enrollment/complete')){expect(runner).toBeDefined();expect(verifySigned(body,runner!.publicKey)).toBe(true);value={orchestratorPublicKey:orchestrator.value.publicKey,credential:orchestrator.sign({...runner,state:'pending',sequence:'0',issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString()})}}
      else if(request.url?.endsWith('/runner/credential')){expect(verifySigned(body,runner!.publicKey)).toBe(true);value={orchestratorPublicKey:orchestrator.value.publicKey,credential:orchestrator.sign({...runner,state:'approved',sequence:'1',issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString()})}}
      else if(request.url?.endsWith('/runner/manifests')){expect(body.payload.manifest.sequence).toBe(body.payload.sequence);value={accepted:true}}
      else if(request.url?.endsWith('/runner/jobs/lease')){const now=new Date(),expires=new Date(Date.now()+60_000);value=orchestrator.sign({schemaVersion:'1',testOnly:true,jobId:'fixture-job',leaseId:'lease',runnerId:runner!.runnerId,sequence:'1',nonce:Buffer.alloc(32,4).toString('base64'),issuedAt:now.toISOString(),expiresAt:expires.toISOString(),leaseExpiresAt:expires.toISOString(),target:{isa:'x64',os:'win32',abi:'msvc'},binary:{corpusId:'testOnly:fixture',sha256:'a'.repeat(64),size:'1',eligible:true},argv:[],repetitions:32,warmups:0,seed:'seed',controls:{},adapters:[],thresholds:{}},now)}
      else{response.statusCode=404;value={error:'missing'}}
      response.setHeader('content-type','application/json');response.end(JSON.stringify(value))
    })
    await new Promise<void>(resolveListen=>server.listen(0,'127.0.0.1',resolveListen))
    const address=server.address();if(!address||typeof address==='string')throw new Error('listen failed')
    const base=`http://127.0.0.1:${address.port}`,state=mkdtempSync(join(tmpdir(),'runner-cli-'));roots.push(state)
    const suffix=process.platform==='win32'?'.exe':'',helper=resolve(import.meta.dirname,`../../crates/measurement-helper/target/debug/measurement-helper${suffix}`),helperSha=sha256(readFileSync(helper))
    const invoke=(args:string[])=>command(['--import','tsx',resolve(import.meta.dirname,'../src/cli.ts'),...args],{ISA_SIM_RUNNER_STATE:state})
    expect((await invoke(['enroll','--url',base,'--token-id','token','--token','secret'])).code).toBe(0)
    expect((await invoke(['capabilities','--publish','--url',base,'--helper',helper,'--helper-sha',helperSha])).code).toBe(0)
    expect((await invoke(['lease','--url',base,'--helper',helper,'--helper-sha',helperSha])).code).toBe(0)
    const leasePath=join(state,'lease.json');expect(JSON.parse(readFileSync(leasePath,'utf8')).payload.testOnly).toBe(true)
    const refused=await invoke(['run','--real-job','--url',base,'--job',leasePath])
    expect(refused.code).toBe(1);expect(refused.stderr).toContain('rejects testOnly')
    await new Promise<void>(resolveClose=>server.close(()=>resolveClose()))
  },20_000)
})

function command(args:string[],environment:Record<string,string>):Promise<{code:number;stdout:string;stderr:string}>{
  return new Promise(resolveCommand=>{const child=spawn(process.execPath,args,{cwd:resolve(import.meta.dirname,'..'),env:{...process.env,...environment},windowsHide:true});const stdout:Buffer[]=[],stderr:Buffer[]=[];child.stdout.on('data',(chunk:Buffer)=>stdout.push(chunk));child.stderr.on('data',(chunk:Buffer)=>stderr.push(chunk));child.on('close',code=>resolveCommand({code:code??-1,stdout:Buffer.concat(stdout).toString(),stderr:Buffer.concat(stderr).toString()}))})
}
