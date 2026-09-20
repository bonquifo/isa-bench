import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { empiricalLaneCapability } from './app.js'
import { NativeCorpusStore } from './corpus.js'
import { EmpiricalStore } from './empirical.js'
import { Identity, type KeyStore } from '../../runner/src/identity.js'

class MemoryStore implements KeyStore{value:Buffer|null=null;async load(){return this.value}async store(_id:string,value:Buffer){this.value=value}}

let root:string|undefined
afterEach(()=>{if(root)rmSync(root,{recursive:true,force:true});root=undefined})

describe('empirical lane capability',()=>{
  it('requires an approved current compatible signed manifest and eligible corpus',async()=>{
    root=mkdtempSync(join(tmpdir(),'empirical-capability-'));const corpusRoot=join(root,'native-corpus');mkdirSync(corpusRoot)
    writeFileSync(join(corpusRoot,'artifact-index.json'),JSON.stringify({schemaVersion:1,corpusVersion:'testOnly',records:[{eligible:true,workload:'fixture',target:'x86_64-linux',triple:'x86_64-unknown-linux-gnu'}]}))
    const identity=await Identity.loadOrCreate(new MemoryStore()),sqlite=new DatabaseSync(':memory:'),corpus=new NativeCorpusStore(root),future=new Date(Date.now()+60_000).toISOString(),past=new Date(0).toISOString();void new EmpiricalStore(sqlite)
    sqlite.prepare("INSERT INTO empirical_runners(id,key_id,public_key,state,credential_expires_at,created_at,updated_at) VALUES(?,?,?,'approved',?,?,?)").run(identity.value.runnerId,identity.value.keyId,identity.value.publicKey,future,new Date().toISOString(),new Date().toISOString())
    expect(empiricalLaneCapability(sqlite,corpus)).toEqual(expect.objectContaining({available:false}))
    const manifest=(arch:string,topology=true)=>({schemaVersion:'1',runnerId:identity.value.runnerId,expiresAt:future,host:{os:{status:'supported',value:{platform:'linux'}},arch:{status:'supported',value:arch},abi:{status:'supported',value:'gnu'}},cpu:{topology:topology?{status:'supported',value:{}}:{status:'unsupported',reason:'testOnly'}},clock:{status:'supported'}})
    const insert=(sequence:number,value:unknown,expires=future)=>sqlite.prepare('INSERT INTO empirical_manifests VALUES(?,?,?,?,?)').run(identity.value.runnerId,sequence,new Date().toISOString(),expires,JSON.stringify(identity.sign({manifest:value})))
    insert(1,manifest('aarch64'));expect(empiricalLaneCapability(sqlite,corpus).available).toBe(false)
    insert(2,manifest('x86_64',false));expect(empiricalLaneCapability(sqlite,corpus).available).toBe(false)
    insert(3,manifest('x86_64'));expect(empiricalLaneCapability(sqlite,corpus).available).toBe(true)
    sqlite.prepare('UPDATE empirical_runners SET credential_expires_at=?').run(past);expect(empiricalLaneCapability(sqlite,corpus).available).toBe(false)
    sqlite.close()
  })
})
