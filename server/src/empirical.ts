import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { canonicalJson, type JsonValue } from '@isa-sim/contracts'

export type Row = Record<string, unknown>
export type EmpiricalRunnerState = 'pending' | 'approved' | 'quarantined' | 'revoked' | 'expired'

export class EmpiricalStore {
  constructor(readonly sqlite: DatabaseSync) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS empirical_enrollment_tokens(id TEXT PRIMARY KEY,secret_hash TEXT NOT NULL,expires_at TEXT NOT NULL,used_at TEXT);
      CREATE TABLE IF NOT EXISTS empirical_challenges(id TEXT PRIMARY KEY,token_id TEXT NOT NULL,runner_id TEXT NOT NULL,key_id TEXT NOT NULL,public_key TEXT NOT NULL,nonce TEXT NOT NULL,expires_at TEXT NOT NULL,used_at TEXT);
      CREATE TABLE IF NOT EXISTS empirical_runners(id TEXT PRIMARY KEY,key_id TEXT UNIQUE NOT NULL,public_key TEXT NOT NULL,state TEXT NOT NULL,credential_json TEXT,credential_expires_at TEXT,last_sequence INTEGER NOT NULL DEFAULT 0,credential_sequence INTEGER NOT NULL DEFAULT 0,cert_fingerprint TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS empirical_runner_credential_history(runner_id TEXT NOT NULL REFERENCES empirical_runners(id),sequence INTEGER NOT NULL,state TEXT NOT NULL,issued_at TEXT NOT NULL,expires_at TEXT NOT NULL,credential_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(runner_id,sequence));
      CREATE TABLE IF NOT EXISTS empirical_operation_nonces(runner_id TEXT NOT NULL,request_id TEXT NOT NULL,nonce TEXT NOT NULL,sequence INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(runner_id,request_id),UNIQUE(runner_id,nonce));
      CREATE TABLE IF NOT EXISTS empirical_manifests(runner_id TEXT NOT NULL REFERENCES empirical_runners(id),sequence INTEGER NOT NULL,observed_at TEXT NOT NULL,expires_at TEXT NOT NULL,envelope_json TEXT NOT NULL,PRIMARY KEY(runner_id,sequence));
      CREATE TABLE IF NOT EXISTS empirical_jobs(id TEXT PRIMARY KEY,spec_json TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',version INTEGER NOT NULL DEFAULT 0,runner_id TEXT,lease_id TEXT,lease_nonce TEXT,lease_expires_at TEXT,last_sequence INTEGER NOT NULL DEFAULT 0,artifact_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS empirical_job_events(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES empirical_jobs(id),runner_id TEXT NOT NULL,sequence INTEGER NOT NULL,kind TEXT NOT NULL,envelope_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(job_id,runner_id,sequence));
      CREATE TABLE IF NOT EXISTS empirical_uploads(hash TEXT PRIMARY KEY,runner_id TEXT NOT NULL,job_id TEXT NOT NULL,lease_id TEXT NOT NULL,lease_nonce TEXT NOT NULL,expected_size INTEGER NOT NULL,complete INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS empirical_upload_chunks(upload_hash TEXT NOT NULL,offset INTEGER NOT NULL,size INTEGER NOT NULL,chunk_hash TEXT NOT NULL,path TEXT NOT NULL,created_at TEXT NOT NULL,ready INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(upload_hash,offset),UNIQUE(upload_hash,chunk_hash,offset));
      CREATE TABLE IF NOT EXISTS empirical_artifacts(hash TEXT PRIMARY KEY,runner_id TEXT NOT NULL,job_id TEXT NOT NULL,size INTEGER NOT NULL,path TEXT NOT NULL,index_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS empirical_audit_chain(id INTEGER PRIMARY KEY AUTOINCREMENT,previous_hash TEXT NOT NULL,entry_hash TEXT UNIQUE NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,outcome TEXT NOT NULL,object_type TEXT NOT NULL,object_id TEXT NOT NULL,detail_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS empirical_jobs_lease ON empirical_jobs(state,lease_expires_at);
      CREATE INDEX IF NOT EXISTS empirical_chunks_upload ON empirical_upload_chunks(upload_hash,offset);
    `)
    const uploadColumns = (sqlite.prepare("PRAGMA table_info('empirical_uploads')").all() as Row[]).map((row) => String(row.name))
    if (!['job_id','lease_id','lease_nonce'].every((column) => uploadColumns.includes(column))) {
      sqlite.exec(`
        DROP TABLE IF EXISTS empirical_upload_chunks;
        DROP TABLE IF EXISTS empirical_uploads;
        DROP TABLE IF EXISTS empirical_artifacts;
        CREATE TABLE empirical_uploads(hash TEXT PRIMARY KEY,runner_id TEXT NOT NULL,job_id TEXT NOT NULL,lease_id TEXT NOT NULL,lease_nonce TEXT NOT NULL,expected_size INTEGER NOT NULL,complete INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE empirical_upload_chunks(upload_hash TEXT NOT NULL,offset INTEGER NOT NULL,size INTEGER NOT NULL,chunk_hash TEXT NOT NULL,path TEXT NOT NULL,created_at TEXT NOT NULL,ready INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(upload_hash,offset),UNIQUE(upload_hash,chunk_hash,offset));
        CREATE TABLE empirical_artifacts(hash TEXT PRIMARY KEY,runner_id TEXT NOT NULL,job_id TEXT NOT NULL,size INTEGER NOT NULL,path TEXT NOT NULL,index_json TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE INDEX empirical_chunks_upload ON empirical_upload_chunks(upload_hash,offset);
      `)
    }
    const runnerColumns = (sqlite.prepare("PRAGMA table_info('empirical_runners')").all() as Row[]).map((row) => String(row.name))
    if (!runnerColumns.includes('credential_sequence')) sqlite.exec('ALTER TABLE empirical_runners ADD COLUMN credential_sequence INTEGER NOT NULL DEFAULT 0')
    if (!runnerColumns.includes('cert_fingerprint')) sqlite.exec('ALTER TABLE empirical_runners ADD COLUMN cert_fingerprint TEXT')
    const credentials = sqlite.prepare('SELECT id,credential_json FROM empirical_runners WHERE credential_json IS NOT NULL').all() as Row[]
    const insertCredential = sqlite.prepare('INSERT OR IGNORE INTO empirical_runner_credential_history VALUES(?,?,?,?,?,?,?)')
    for (const row of credentials) {
      try {
        const envelope = JSON.parse(String(row.credential_json)) as { payload?: Record<string, unknown> }
        const payload = envelope.payload
        if (payload && Number.isSafeInteger(Number(payload.sequence)) && typeof payload.state === 'string' && typeof payload.issuedAt === 'string' && typeof payload.expiresAt === 'string') {
          insertCredential.run(String(row.id), Number(payload.sequence), payload.state, payload.issuedAt, payload.expiresAt, String(row.credential_json), new Date().toISOString())
        }
      } catch {}
    }
    const chunkColumns = (sqlite.prepare("PRAGMA table_info('empirical_upload_chunks')").all() as Row[]).map((row) => String(row.name))
    if (!chunkColumns.includes('ready')) sqlite.exec('ALTER TABLE empirical_upload_chunks ADD COLUMN ready INTEGER NOT NULL DEFAULT 1')
  }

  transaction<T>(operation: () => T): T {
    this.sqlite.exec('BEGIN IMMEDIATE')
    try { const value = operation(); this.sqlite.exec('COMMIT'); return value }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error }
  }

  audit(actor: string, action: string, outcome: 'success' | 'failure', objectType: string, objectId: string, detail: Record<string, JsonValue>, now = new Date()): void {
    const previous = this.sqlite.prepare('SELECT entry_hash FROM empirical_audit_chain ORDER BY id DESC LIMIT 1').get() as Row | undefined
    const previousHash = String(previous?.entry_hash ?? '0'.repeat(64))
    const createdAt = now.toISOString()
    const safeDetail = canonicalJson(detail)
    const entryHash = hash(canonicalJson({ previousHash, actor, action, outcome, objectType, objectId, detail, createdAt }))
    this.sqlite.prepare('INSERT INTO empirical_audit_chain(previous_hash,entry_hash,actor,action,outcome,object_type,object_id,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(previousHash, entryHash, actor, action, outcome, objectType, objectId, safeDetail, createdAt)
  }

  issueEnrollmentToken(ttlMs: number, now = Date.now()) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 3_600_000) throw new Error('invalid enrollment TTL')
    const id = randomUUID(), token = randomBytes(32).toString('base64url'), expiresAt = new Date(now + ttlMs).toISOString()
    this.transaction(() => {
      this.sqlite.prepare('INSERT INTO empirical_enrollment_tokens VALUES(?,?,?,NULL)').run(id, hash(token), expiresAt)
      this.audit('admin:loopback', 'enrollment-token.issue', 'success', 'token', id, { expiresAt })
    })
    return { id, token, expiresAt }
  }

  createChallenge(input: { tokenId: string; token: string; runnerId: string; keyId: string; publicKey: string }, now = Date.now()) {
    return this.transaction(() => {
      const row = this.sqlite.prepare('SELECT * FROM empirical_enrollment_tokens WHERE id=?').get(input.tokenId) as Row | undefined
      const actual = Buffer.from(hash(input.token), 'hex'), expected = Buffer.from(String(row?.secret_hash ?? '0'.repeat(64)), 'hex')
      if (!row || row.used_at || actual.length !== expected.length || !timingSafeEqual(actual, expected) || Date.parse(String(row.expires_at)) <= now) throw new Error('invalid or expired enrollment token')
      const usedAt = new Date(now).toISOString()
      if (this.sqlite.prepare('UPDATE empirical_enrollment_tokens SET used_at=? WHERE id=? AND used_at IS NULL').run(usedAt, input.tokenId).changes !== 1) throw new Error('enrollment token replay')
      const result = { id: randomUUID(), nonce: randomBytes(32).toString('base64'), expiresAt: new Date(now + 300_000).toISOString() }
      this.sqlite.prepare('INSERT INTO empirical_challenges VALUES(?,?,?,?,?,?,?,NULL)').run(result.id,input.tokenId,input.runnerId,input.keyId,input.publicKey,result.nonce,result.expiresAt)
      this.audit(input.runnerId, 'enrollment.challenge', 'success', 'challenge', result.id, { keyId: input.keyId })
      return result
    })
  }

  challenge(id: string): Row | null { return this.sqlite.prepare('SELECT * FROM empirical_challenges WHERE id=?').get(id) as Row | undefined ?? null }

  completeChallenge(id: string, credentialJson: string, now = Date.now()): void {
    this.transaction(() => {
      const challenge = this.challenge(id)
      if (!challenge || challenge.used_at || Date.parse(String(challenge.expires_at)) <= now) throw new Error('challenge replay or expiry')
      const existing = this.runner(String(challenge.runner_id))
      if (existing && (existing.key_id !== challenge.key_id || existing.public_key !== challenge.public_key)) throw new Error('runner identity conflict')
      const timestamp = new Date(now).toISOString()
      if (this.sqlite.prepare('UPDATE empirical_challenges SET used_at=? WHERE id=? AND used_at IS NULL').run(timestamp,id).changes !== 1) throw new Error('challenge replay')
      const inserted = this.sqlite.prepare(`INSERT INTO empirical_runners(id,key_id,public_key,state,credential_json,credential_expires_at,created_at,updated_at) VALUES(?,?,?,'pending',?,?,?,?) ON CONFLICT(id) DO NOTHING`)
        .run(String(challenge.runner_id),String(challenge.key_id),String(challenge.public_key),credentialJson,new Date(now+31_536_000_000).toISOString(),timestamp,timestamp)
      if (inserted.changes !== 1 && !existing) throw new Error('runner key conflict')
      const credential = JSON.parse(credentialJson) as { payload: { sequence: string; state: string; issuedAt: string; expiresAt: string } }
      this.sqlite.prepare('INSERT OR IGNORE INTO empirical_runner_credential_history VALUES(?,?,?,?,?,?,?)').run(String(challenge.runner_id),Number(credential.payload.sequence),credential.payload.state,credential.payload.issuedAt,credential.payload.expiresAt,credentialJson,timestamp)
      this.audit(String(challenge.runner_id),'enrollment.complete','success','runner',String(challenge.runner_id),{keyId:String(challenge.key_id)})
    })
  }

  listRunners(): Row[] { return this.sqlite.prepare('SELECT id,key_id,state,credential_expires_at,last_sequence,credential_sequence,created_at,updated_at FROM empirical_runners ORDER BY created_at').all() as Row[] }
  runner(id: string): Row | null { return this.sqlite.prepare('SELECT * FROM empirical_runners WHERE id=?').get(id) as Row | undefined ?? null }

  setRunnerCredential(id: string, state: EmpiricalRunnerState, credentialJson: string, expiresAt: string, certFingerprint?: string): void {
    this.transaction(() => {
      const existing = this.runner(id); if (!existing) throw new Error('runner not found')
      if (existing.state === 'revoked' && state !== 'revoked') throw new Error('revocation is permanent')
      const sequence = Number(existing.credential_sequence) + 1
      this.sqlite.prepare('UPDATE empirical_runners SET state=?,credential_json=?,credential_expires_at=?,credential_sequence=?,cert_fingerprint=COALESCE(?,cert_fingerprint),updated_at=? WHERE id=?')
        .run(state,credentialJson,expiresAt,sequence,certFingerprint??null,new Date().toISOString(),id)
      const credential = JSON.parse(credentialJson) as { payload: { issuedAt: string; expiresAt: string } }
      this.sqlite.prepare('INSERT INTO empirical_runner_credential_history VALUES(?,?,?,?,?,?,?)').run(id,sequence,state,credential.payload.issuedAt,credential.payload.expiresAt,credentialJson,new Date().toISOString())
      this.audit('admin:loopback',`runner.${state}`,'success','runner',id,{oldState:String(existing.state),newState:state,credentialSequence:sequence})
    })
  }

  consumeOperation(runnerId: string, requestId: string, nonce: string, sequence: number, action: string, objectId: string, idempotent = false): void {
    const runner = this.runner(runnerId)
    if (!runner || runner.state !== 'approved' || Date.parse(String(runner.credential_expires_at)) <= Date.now()) throw new Error('runner not approved')
    const previous = this.sqlite.prepare('SELECT nonce,sequence FROM empirical_operation_nonces WHERE runner_id=? AND request_id=?').get(runnerId,requestId) as Row|undefined
    if (idempotent && previous && previous.nonce === nonce && Number(previous.sequence) === sequence) return
    if (!Number.isSafeInteger(sequence) || sequence <= Number(runner.last_sequence)) throw new Error('operation replay or sequence rollback')
    this.sqlite.prepare('INSERT INTO empirical_operation_nonces VALUES(?,?,?,?,?)').run(runnerId,requestId,nonce,sequence,new Date().toISOString())
    if (this.sqlite.prepare('UPDATE empirical_runners SET last_sequence=?,updated_at=? WHERE id=? AND last_sequence<?').run(sequence,new Date().toISOString(),runnerId,sequence).changes !== 1) throw new Error('operation sequence conflict')
    this.audit(runnerId,action,'success','operation',objectId,{requestId,sequence})
  }

  acceptManifest(runnerId: string, sequence: number, observedAt: string, expiresAt: string, envelopeJson: string, requestId: string, nonce: string): void {
    this.transaction(() => {
      this.consumeOperation(runnerId,requestId,nonce,sequence,'manifest.accept',runnerId)
      this.sqlite.prepare('INSERT INTO empirical_manifests VALUES(?,?,?,?,?)').run(runnerId,sequence,observedAt,expiresAt,envelopeJson)
    })
  }

  createJob(id: string, spec: Record<string, unknown>, now = Date.now()): Row {
    const timestamp = new Date(now).toISOString()
    return this.transaction(() => {
      this.sqlite.prepare("INSERT INTO empirical_jobs(id,spec_json,state,created_at,updated_at) VALUES(?,?,'queued',?,?)").run(id,JSON.stringify(spec),timestamp,timestamp)
      this.audit('admin:loopback','job.create','success','job',id,{specHash:hash(canonicalJson(spec as JsonValue))})
      return this.sqlite.prepare('SELECT * FROM empirical_jobs WHERE id=?').get(id) as Row
    })
  }

  lease(runnerId: string, ttlMs: number, now = Date.now()): Row | null {
    this.recoverExpiredLeases(now)
    return this.transaction(() => {
      const job = this.sqlite.prepare("SELECT * FROM empirical_jobs WHERE state='queued' ORDER BY created_at LIMIT 1").get() as Row|undefined
      if (!job) return null
      const leaseId=randomUUID(), nonce=randomBytes(32).toString('base64'), expiresAt=new Date(now+ttlMs).toISOString()
      if (this.sqlite.prepare("UPDATE empirical_jobs SET state='leased',version=version+1,runner_id=?,lease_id=?,lease_nonce=?,lease_expires_at=?,updated_at=? WHERE id=? AND state='queued' AND version=?")
        .run(runnerId,leaseId,nonce,expiresAt,new Date(now).toISOString(),String(job.id),Number(job.version)).changes!==1) throw new Error('lease conflict')
      this.audit(runnerId,'job.lease','success','job',String(job.id),{leaseId,leaseNonceHash:hash(nonce),expiresAt})
      return {...job,state:'leased',runner_id:runnerId,lease_id:leaseId,lease_nonce:nonce,lease_expires_at:expiresAt}
    })
  }

  transitionEvent(jobId:string,runnerId:string,sequence:number,kind:string,envelopeJson:string,leaseId:string,nonce:string,requestId:string,operationNonce:string):Row {
    return this.transaction(()=>{
      const job=this.sqlite.prepare('SELECT * FROM empirical_jobs WHERE id=?').get(jobId) as Row|undefined
      if(!job||job.runner_id!==runnerId||job.lease_id!==leaseId||job.lease_nonce!==nonce) throw new Error('lease binding mismatch')
      if(Date.parse(String(job.lease_expires_at))<=Date.now()) throw new Error('lease expired')
      const states:Record<string,string[]>={leased:['accept','fail'],accepted:['heartbeat','start','fail'],running:['heartbeat','event','finish','fail']}
      if(!states[String(job.state)]?.includes(kind)) throw new Error('invalid job event transition')
      this.consumeOperation(runnerId,requestId,operationNonce,sequence,`job.${kind}`,jobId)
      const next=kind==='accept'?'accepted':kind==='start'?'running':kind==='finish'?'finished':kind==='fail'?'failed':String(job.state)
      const now=Date.now(),leaseExpires=kind==='heartbeat'?new Date(Math.min(now+60_000,Date.parse(String(job.created_at))+86_400_000)).toISOString():String(job.lease_expires_at)
      if(this.sqlite.prepare('UPDATE empirical_jobs SET state=?,last_sequence=?,lease_expires_at=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(next,sequence,leaseExpires,new Date(now).toISOString(),jobId,Number(job.version)).changes!==1) throw new Error('job version conflict')
      this.sqlite.prepare('INSERT INTO empirical_job_events(job_id,runner_id,sequence,kind,envelope_json,created_at) VALUES(?,?,?,?,?,?)').run(jobId,runnerId,sequence,kind,envelopeJson,new Date().toISOString())
      return this.sqlite.prepare('SELECT * FROM empirical_jobs WHERE id=?').get(jobId) as Row
    })
  }

  recoverExpiredLeases(now=Date.now()):number {
    return this.transaction(()=>{
      const expired=this.sqlite.prepare("SELECT id,state,runner_id,lease_id FROM empirical_jobs WHERE state IN ('leased','accepted','running') AND lease_expires_at<=?").all(new Date(now).toISOString()) as Row[]
      for(const job of expired){
        const next=job.state==='running'?'failed':'queued'
        this.sqlite.prepare("UPDATE empirical_jobs SET state=?,runner_id=CASE WHEN ?='queued' THEN NULL ELSE runner_id END,lease_id=CASE WHEN ?='queued' THEN NULL ELSE lease_id END,lease_nonce=CASE WHEN ?='queued' THEN NULL ELSE lease_nonce END,lease_expires_at=NULL,version=version+1,updated_at=? WHERE id=?").run(next,next,next,next,new Date(now).toISOString(),String(job.id))
        this.audit('system','lease.expire','success','job',String(job.id),{oldState:String(job.state),newState:next,leaseId:String(job.lease_id??'')})
      }
      return expired.length
    })
  }
}

export const hash = (value:string|Uint8Array):string=>createHash('sha256').update(value).digest('hex')
