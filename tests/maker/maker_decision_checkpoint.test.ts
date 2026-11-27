import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { FirstDecisionRecorder, backupDecisionGenesis, checkpointDatabaseDigest, checkpointWire } from '../../scripts/research/maker_decision_checkpoint';

function fixture() {
  const recorder = new FirstDecisionRecorder(1024 * 1024);
  const db = new Database(':memory:', { verbose: recorder.traceCallback });
  db.exec('CREATE TABLE ordinary_effects(id INTEGER PRIMARY KEY, value TEXT);');
  recorder.bindPrivateDatabase(db);
  recorder.confirmNativeTrace(db);
  recorder.beginApplicationWitness();
  recorder.started(db, () => ({ database: checkpointDatabaseDigest(db) }));
  return { recorder, db };
}
const frontier = { epoch: 'authored-timer-guard-only', sample: {}, index: 0, ordinal: 0,
  appliedFrames: 0, proofHead: 'authored', at: { utc: 1000, mono: 1000 }, randomState: 7, current: true };
const cursor = { ordinal: 0, at: frontier.at, randomState: 7 };

describe('ENG035 native timer and state evidence', () => {
  it('refuses unsupported native verbose values without coercion or exceptions', () => {
    for(const args of [[undefined],['SELECT 1','unexpected extra value'],[17]]){
      const recorder=new FirstDecisionRecorder(1024);
      expect(()=>recorder.traceCallback(...args)).not.toThrow();
      recorder.close();
      expect(recorder.result()).toMatchObject({status:'INCOMPLETE',reason:'decision_checkpoint:unsupported_native_verbose',verifiedComplete:false});
    }
  });

  it('refuses a real timer callback even when elapsed time is far below the cutoff', async () => {
    const { recorder, db } = fixture();
    const interval = setInterval(() => {}, 60000);
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 1));
      recorder.close();
      const result = recorder.result();
      expect(result.status).toBe('INCOMPLETE');
      expect(result.reason).toBe('decision_checkpoint:native_timeout_callback');
      expect(result.nativeTimerObservation.beforeCallbacks).toBeGreaterThan(0);
      expect(result.verifiedComplete).toBe(false);
    } finally { clearInterval(interval); recorder.close(); db.close(); }
  });

  it('refuses a native timeout initialized before the observation hook', async () => {
    let release!:()=>void;
    const dispatched=new Promise<void>(resolve=>{release=resolve});
    const oldTimer=setTimeout(()=>release(),1);
    const {recorder,db}=fixture();
    const interval=setInterval(()=>{},60000);
    try {
      await dispatched;recorder.close();
      expect(recorder.result().reason).toBe('decision_checkpoint:native_timeout_callback');
      expect(recorder.result().nativeTimerObservation.beforeCallbacks).toBeGreaterThan(0);
    } finally {clearTimeout(oldTimer);clearInterval(interval);recorder.close();db.close()}
  });

  it('retains ordinary native writes while withholding self-certification', () => {
    const { recorder, db } = fixture();
    const interval = setInterval(() => {}, 60000);
    try {
      recorder.sample(frontier);
      recorder.sampleEntry(() => ({ database: checkpointDatabaseDigest(db) }));
      recorder.tick(() => ({ database: checkpointDatabaseDigest(db) }));
      db.prepare('INSERT INTO ordinary_effects VALUES (?,?)').run(1, 'same native effect');
      recorder.completed('COMMITTED', cursor, () => ({ database: checkpointDatabaseDigest(db) }));
      recorder.close();
      const result = recorder.result();
      expect(db.prepare('SELECT * FROM ordinary_effects').all()).toEqual([{ id: 1, value: 'same native effect' }]);
      expect(db.exec('SELECT 1')).toBe(db);
      expect(result.reason).toBe(null);
      expect(result.nativeTimerObservation.registrations.map(x => x.delayMs)).toEqual([60000]);
      expect(result.nativeTimerObservation.beforeCallbacks).toBe(0);
      expect(result.status).toBe('REQUIRES_INDEPENDENT_PARITY_AND_CUSTODY');
      expect(result.verifiedComplete).toBe(false);
    } finally { clearInterval(interval); recorder.close(); db.close(); }
  });

  it('refuses absent expected timer registration rather than assuming a timer model', () => {
    const { recorder, db } = fixture();
    try {
      recorder.sample(frontier); recorder.tick(() => ({}));
      recorder.completed('COMMITTED', cursor, () => ({})); recorder.close();
      expect(recorder.result().reason).toBe('decision_checkpoint:unsupported_timer_registration');
    } finally { recorder.close(); db.close(); }
  });

  it('preserves a borrowed native statement receiver but rejects misleading attribution', () => {
    const { recorder, db } = fixture();
    const interval = setInterval(() => {}, 60000);
    try {
      recorder.sample(frontier); recorder.tick(() => ({}));
      const first = db.prepare('INSERT INTO ordinary_effects VALUES (?,\'first\')');
      const second = db.prepare('INSERT INTO ordinary_effects VALUES (?,\'second\')');
      Reflect.apply(first.run, second, [2]);
      recorder.completed('COMMITTED', cursor, () => ({})); recorder.close();
      expect(db.prepare('SELECT * FROM ordinary_effects').all()).toEqual([{ id: 2, value: 'second' }]);
      expect(recorder.result().reason).toBe('decision_checkpoint:borrowed_statement_receiver');
    } finally { clearInterval(interval); recorder.close(); db.close(); }
  });

  it('distinguishes native Int64 and BLOB states without JSON numeric coercion', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE exact_values(i INTEGER,b BLOB);');
      db.prepare('INSERT INTO exact_values VALUES (?,?)').run(9007199254740993n, Buffer.from([0, 255]));
      const before = checkpointDatabaseDigest(db);
      const row = db.prepare('SELECT * FROM exact_values').safeIntegers().get() as { i: bigint; b: Buffer };
      expect(row.i).toBe(9007199254740993n);
      expect(row.b.equals(Buffer.from([0, 255]))).toBe(true);
      db.prepare('UPDATE exact_values SET i=?').run(9007199254740992n);
      expect(checkpointDatabaseDigest(db).sha256).not.toBe(before.sha256);
      expect(checkpointWire(-Infinity)).toEqual(['number', '-Infinity']);
    } finally { db.close(); }
  });

  it('takes a genuine readonly coherent backup and preserves its Int64/BLOB content', async () => {
    const root=mkdtempSync(join(tmpdir(),'eng035-genesis-')),file=join(root,'source.sqlite');
    const seed=new Database(file);
    seed.exec("CREATE TABLE paper_consumed_epochs(epoch INTEGER PRIMARY KEY);CREATE TABLE paper_replay_cursor(epoch TEXT PRIMARY KEY);CREATE TABLE exact_state(i INTEGER,b BLOB);INSERT INTO paper_consumed_epochs VALUES(7);INSERT INTO paper_replay_cursor VALUES('authored/epoch-000007');");
    seed.prepare('INSERT INTO exact_state VALUES(?,?)').run(9007199254740993n,Buffer.from([0,255]));seed.close();
    const original=createHash('sha256').update(readFileSync(file)).digest('hex');
    const source=new Database(file,{readonly:true,fileMustExist:true});
    try {
      const receipt=await backupDecisionGenesis(source,join(root,'fresh-image'),7);
      const image=new Database(receipt.path,{readonly:true,fileMustExist:true});
      try {
        const row=image.prepare('SELECT * FROM exact_state').safeIntegers().get() as {i:bigint;b:Buffer};
        expect(row.i).toBe(9007199254740993n);expect(row.b.equals(Buffer.from([0,255]))).toBe(true);
        expect(createHash('sha256').update(readFileSync(receipt.path)).digest('hex')).toBe(receipt.sha256);
      } finally { image.close(); }
      expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(original);
    } finally { source.close();rmSync(root,{recursive:true,force:true}); }
  });

  it('rejects a backup with an unconsumed epoch cursor instead of calling it a fresh genesis', async () => {
    const root=mkdtempSync(join(tmpdir(),'eng035-incomplete-')),file=join(root,'source.sqlite');
    const seed=new Database(file);
    seed.exec("CREATE TABLE paper_consumed_epochs(epoch INTEGER PRIMARY KEY);CREATE TABLE paper_replay_cursor(epoch TEXT PRIMARY KEY);INSERT INTO paper_consumed_epochs VALUES(7);INSERT INTO paper_replay_cursor VALUES('authored/epoch-000008');");seed.close();
    const source=new Database(file,{readonly:true,fileMustExist:true});
    try { await expect(backupDecisionGenesis(source,join(root,'rejected-image'),7)).rejects.toThrow('incomplete_epoch_cursor'); }
    finally { source.close();rmSync(root,{recursive:true,force:true}); }
  });
});
