// Pruebas con una API de Stays simulada
process.env.DATA_DIR=__dirname+'/data'; require('fs').rmSync(process.env.DATA_DIR,{recursive:true,force:true});
process.env.AUTO_DRY_RUN='false';process.env.RULES_PATH=__dirname+'/rules_clp_test.json'; process.env.AUTO_ENABLED='true';
const P=__dirname+'/';
const auto=require(P+'scheduler.js'); const T=auto._test;
const assert=require('assert');
// datos simulados
const listings=[{_id:'id_cn127',internalName:'CN-127'},{_id:'id_vm126',internalName:'VM-126 (R)'},{_id:'id_stgo26',internalName:'STGO-26'},{_id:'id_stgo15',internalName:'STGO-15'}];
const base={id_cn127:50000,id_vm126:100000,id_stgo26:40000,id_stgo15:70000};
const cal={}; // listing|date -> {avail, price}
const writes=[];
function night(id,d){const k=id+'|'+d;if(!cal[k])cal[k]={avail:1,price:base[id]};return cal[k]}
let reflect=true; // si el calendario refleja el precio "event"
const http={
 get:async url=>{
  if(url.includes('/content/listings')){const skip=+(url.match(/skip=(\d+)/)||[0,0])[1];return{data:listings.slice(skip,skip+20)}}
  const m=url.match(/calendar\/listing\/([^?]+)\?from=([\d-]+)/);const n=night(m[1],m[2]);
  return{data:[{date:m[2],avail:n.avail,prices:[{minStay:1,_mcval:{CLP:n.price,USD:n.price/900}}]}]}},
 post:async(url,body)=>{writes.push(body);if(reflect)night(body._idlisting,body.from).price=body.price;return{data:{_id:'sell'+writes.length}}}};
T.setDeps(http,'mock');
(async()=>{
 // 1) Unidad de reglas básicas
 const wd=T.isoWeekday;assert.equal(wd('2026-10-30'),5);assert.equal(T.addDays('2026-10-31',1),'2026-11-01');
 // 2) Martes 27-oct 09:00 → costa: llegada viernes 30 (k=3) -6%; nada para hoy
 let r=await T.tick({at:'2026-10-27T09:00'});
 const ap=r.plan.filter(x=>x.action==='aplicado');
 console.log('Mar 09:00',ap.map(x=>`${x.unit} ${x.date} -${x.pct}% ${x.base}->${x.target}`));
 assert.deepEqual(ap.map(x=>x.unit+'|'+x.date).sort(),['CN-127|2026-10-30','STGO-26|2026-10-27','VM-126 (R)|2026-10-30']);
 assert.equal(ap.find(x=>x.unit==='CN-127').target,47000);
 // 3) Mismo martes 09:00 otra vez: no repite
 r=await T.tick({at:'2026-10-27T09:05'});assert.equal(r.plan.filter(x=>x.action==='aplicado').length,0);
 // 4) Martes 09:30 STGO-26 hoy -10% ; 10:00 costa hoy -12%
 r=await T.tick({at:'2026-10-27T10:00'});
 let a=r.plan.filter(x=>x.action==='aplicado').map(x=>`${x.unit}|${x.date}|${x.pct}|${x.target}`);console.log('Mar 10:00',a);
 assert(!a.some(x=>x.startsWith('STGO-26|2026-10-27')));assert(a.includes('CN-127|2026-10-27|12|44000'));assert(a.includes('VM-126 (R)|2026-10-27|12|88000'));
 // 5) 15:00: costa hoy -20% calculado sobre base original (no acumulado), STGO-26 -18% (desde 14), STGO-15 -8% hoy, costa mañana -10%
 r=await T.tick({at:'2026-10-27T15:00'});
 a=r.plan.filter(x=>x.action==='aplicado').map(x=>`${x.unit}|${x.date}|${x.pct}|${x.base}|${x.target}`);console.log('Mar 15:00',a);
 assert(a.includes('CN-127|2026-10-27|20|50000|40000'));        // 50000*0.8, no 44000*0.8
 assert(a.includes('VM-126 (R)|2026-10-27|20|100000|80000'));
 assert(a.includes('STGO-26|2026-10-27|18|40000|32800'));
 assert(a.includes('STGO-15|2026-10-27|8|70000|64400'));
 assert(a.includes('CN-127|2026-10-28|10|50000|45000'));
 // 6) Piso: VM-126 piso 70000; base 80000 -20% = 64000 -> 70000
 cal['id_vm126|2026-10-29']={avail:1,price:80000};
 r=await T.tick({at:'2026-10-29T15:30'});
 let v=r.plan.find(x=>x.unit==='VM-126 (R)'&&x.date==='2026-10-29');console.log('Piso',v.action,v.target);assert.equal(v.target,70000);
 // 7) Noche ocupada: no se toca
 cal['id_stgo26|2026-10-30']={avail:0,price:40000};
 r=await T.tick({at:'2026-10-30T14:00'});
 v=r.plan.find(x=>x.unit==='STGO-26'&&x.date==='2026-10-30');console.log('Ocupada',v.action);assert.equal(v.action,'ocupada');
 // 8) PriceLabs cambia precio por fuera -> nueva base y reaplica
 cal['id_cn127|2026-10-31']={avail:1,price:60000};
 r=await T.tick({at:'2026-10-30T15:00'}); // CN 31-oct k=1 -10% -> 54000
 cal['id_cn127|2026-10-31'].price=65000; // PriceLabs re-sync
 r=await T.tick({at:'2026-10-31T10:00'}); // hoy -12% sobre 65000 = 57200
 v=r.plan.find(x=>x.unit==='CN-127'&&x.date==='2026-10-31'&&x.action==='aplicado');console.log('Cambio externo',v.base,v.target);assert.equal(v.base,65000);assert.equal(v.target,57200);
 // 9) Calendario que NO refleja el precio "event": no debe reescribir cada 15 min
 reflect=false;const before=writes.length;
 cal['id_stgo15|2026-11-02']={avail:1,price:70000};
 await T.tick({at:'2026-11-02T14:00'});await T.tick({at:'2026-11-02T14:15'});await T.tick({at:'2026-11-02T16:00'});
 const w=writes.slice(before).filter(x=>x._idlisting==='id_stgo15'&&x.from==='2026-11-02');console.log('Sin reflejo, escrituras',w.length);assert.equal(w.length,1);
 // 10) Preview no escribe ni guarda
 const n0=writes.length;const pv=await T.tick({mode:'preview',at:'2026-11-03T15:00'});assert.equal(writes.length,n0);console.log('Preview',pv.plan.filter(x=>x.action==='aplicaría').length,'acciones');
 // 11) Simulación (dryRun) no escribe
 process.env.AUTO_DRY_RUN='true';const st=T.state();delete st.config.dryRun;
 const n1=writes.length;await T.tick({at:'2026-11-04T15:00'});assert.equal(writes.length,n1);console.log('DryRun ok');
 // 12) Lunes: regla 2-4 días NO aplica (solo mar/mié)
 const pf=require(process.env.RULES_PATH).profiles.costa;
 assert.equal(T.pctFor(pf,4,{date:'2026-10-26',hhmm:'09:00'},'2026-10-30').pct,0);
 assert.equal(T.pctFor(pf,2,{date:'2026-10-28',hhmm:'00:00'},'2026-10-30').pct,6);
 assert.equal(T.pctFor(pf,3,{date:'2026-10-28',hhmm:'09:00'},'2026-10-31').pct,0); // sábado no
 // 13) Hora local real (zona horaria)
 console.log('Ahora Santiago',T.localNow('America/Santiago'),'Lima',T.localNow('America/Lima'));
 // USD real: redondeo a 1 y moneda USD
 const ru=require(P+'rules.json');assert.equal(ru.currency,'USD');assert.equal(ru.roundTo,1);
 const ex=T.extractDay([{date:'2026-11-05',avail:1,prices:[{_mcval:{USD:63.4,CLP:59000}}]}],'2026-11-05','USD');assert.equal(ex.price,63.4);
 console.log('\nTODAS LAS PRUEBAS OK · escrituras simuladas:',writes.length);
 console.log('Ejemplo body:',JSON.stringify(writes[0]));
})().catch(e=>{console.error('FALLA',e);process.exit(1)});
