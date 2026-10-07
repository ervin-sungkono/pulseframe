import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {loadSources} from './load-source.mjs';
const modules=await loadSources(), routes=modules['preset-route'], actions=modules['preset-id-route'];
const settings=modules['visual-settings'].migrateSettings(modules['visual-settings'].settingsSchema.parse({mode:'edges',particleMode:'stardust',particleFlow:'drift',backdrop:'clean',primary:'#9b72ff',secondary:'#61e5ff',background:'#080c20',sensitivity:1.3,quietThreshold:.006,bassBoost:1,responseStyle:'balanced',atmosphere:1,particleCount:120,glow:.95,visualScale:1.1,motionSpeed:1,particleSize:1,beatRays:true,trails:false,particles:true,videoOpacity:55,logoOpacity:100,showTrackInfo:true,trackTitle:'Song',trackArtist:'Artist',infoPosition:'bottom',infoAlign:'center',infoSize:1,showTimer:false}));
function database(){
  const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../drizzle/0000_lucky_winter_soldier.sql',import.meta.url),'utf8'));
  db.exec(readFileSync(new URL('../drizzle/0001_personal_quick_look.sql',import.meta.url),'utf8'));
  return {close:()=>db.close(),prepare(sql){const statement=db.prepare(sql);let args=[];return {bind(...values){args=values;return this;},async all(){return {results:statement.all(...args)};},async first(){return statement.get(...args)??null;},async run(){const result=statement.run(...args);return {meta:{changes:Number(result.changes)}};}};}};
}
const origin='https://pulseframe.example';
const req=(path='',method='GET',payload,headers={})=>new Request(origin+'/api/presets'+path,{method,headers:{...headers,...(payload?{'Content-Type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{})});
function begin(user='alice'){globalThis.__presetTestDB=database();globalThis.__presetTestUser={userId:user,email:user+'@example.test'};}
function end(){globalThis.__presetTestDB?.close();delete globalThis.__presetTestDB;delete globalThis.__presetTestUser;}
test('preset API requires a signed-in identity and rejects cross-site writes',async()=>{
  begin();try{
    globalThis.__presetTestUser=null;
    assert.equal((await routes.GET(req())).status,401);
    assert.equal((await routes.POST(req('','POST',{id:crypto.randomUUID(),name:'look',settings}))).status,401);
    globalThis.__presetTestUser={userId:'alice',email:'alice@example.test'};
    assert.equal((await routes.POST(req('','POST',{id:crypto.randomUUID(),name:'look',settings},{Origin:'https://foreign.example'}))).status,403);
    assert.equal((await routes.POST(req('','POST',{id:crypto.randomUUID(),name:'look',settings},{'Sec-Fetch-Site':'cross-site'}))).status,403);
    assert.equal((await routes.GET(req())).status,200);
  }finally{end();}
});
test('preset API saves across fresh store instances, validates input and makes retries idempotent',async()=>{
  begin();try{
    const id=crypto.randomUUID(),body={id,name:'  Neon lake  ',settings};
    const first=await routes.POST(req('','POST',body,{Origin:origin}));assert.equal(first.status,201);
    const saved=(await first.json()).preset;assert.equal(saved.name,'Neon lake');assert.equal(saved.settings.mode,'edges');assert.equal('trackTitle' in saved.settings,false);
    assert.equal((await routes.POST(req('','POST',body,{Origin:origin}))).status,200);
    const rows=(await (await routes.GET(req())).json()).presets;assert.equal(rows.length,1);assert.equal(rows[0].id,id);
    const store=new modules['preset-store'].PresetStore(globalThis.__presetTestDB);assert.equal((await store.get('alice',id)).name,'Neon lake');
    assert.equal((await routes.POST(req('','POST',{...body,id:crypto.randomUUID(),name:' '},{Origin:origin}))).status,400);
    assert.equal((await routes.POST(req('','POST',{...body,id:crypto.randomUUID(),settings:{...settings,glow:1000}},{Origin:origin}))).status,400);
    const context={params:Promise.resolve({id})};assert.equal((await actions.PATCH(req('/'+id,'PATCH',{name:'Lake',expectedRevision:saved.revision},{Origin:origin}),context)).status,200);
    const renamed=await store.get('alice',id);assert.equal(renamed.name,'Lake');
    globalThis.__presetTestUser={userId:'bob',email:'bob@example.test'};
    assert.equal((await (await routes.GET(req())).json()).presets.length,0);
    assert.equal((await actions.PATCH(req('/'+id,'PATCH',{name:'Stolen',expectedRevision:renamed.revision},{Origin:origin}),context)).status,404);
    assert.equal((await actions.DELETE(req('/'+id,'DELETE',undefined,{Origin:origin}),context)).status,404);
    assert.equal((await store.get('alice',id)).name,'Lake');
    globalThis.__presetTestUser={userId:'alice',email:'alice@example.test'};
    assert.equal((await actions.DELETE(req('/'+id,'DELETE',undefined,{Origin:origin}),context)).status,200);
    assert.equal((await store.get('alice',id)),null);
  }finally{end();}
});
test('preset library has no item-count cap, pages stable tied timestamps and treats search literally',async()=>{
  begin();try{
    const store=new modules['preset-store'].PresetStore(globalThis.__presetTestDB),ids=new Set();
    for(let i=0;i<125;i++){const id=crypto.randomUUID();ids.add(id);await store.save('alice',id,`Look ${i}`,modules.presets.presetStyle(settings));}
    await globalThis.__presetTestDB.prepare('UPDATE visual_presets SET updated_at = ? WHERE user_id = ?').bind(123456789,'alice').run();
    let cursor,found=[];
    do {const page=await store.list('alice','',cursor);found.push(...page.presets);cursor=page.cursor ? {value:Number(page.cursor.split(':')[0]),id:page.cursor.split(':')[1]} : undefined;}while(cursor);
    assert.equal(found.length,125);assert.equal(new Set(found.map(x=>x.id)).size,125);assert.deepEqual(new Set(found.map(x=>x.id)),ids);
    await store.save('alice',crypto.randomUUID(),'50%_\'s look',modules.presets.presetStyle(settings));
    assert.equal((await store.list('alice','%_')).presets.length,1);
    assert.equal((await store.list('alice',"' OR 1=1 --")).presets.length,0);
    assert.equal((await store.list('bob')).presets.length,0);
  }finally{end();}
});
