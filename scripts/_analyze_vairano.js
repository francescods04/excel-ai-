require('dotenv').config({ path: '/Users/francescodelsesto/Downloads/mm/excel/.env' });
const https = require('https');
function req(m,u,h,b){return new Promise((r,j)=>{const U=new URL(u);const d=b?JSON.stringify(b):null;const o={hostname:U.hostname,port:443,path:U.pathname+(U.search||''),method:m,headers:{...h}};if(d){o.headers['Content-Length']=Buffer.byteLength(d);o.headers['Content-Type']='application/json';}const rq=https.request(o,res=>{let s='';res.on('data',c=>s+=c);res.on('end',()=>{try{r({status:res.statusCode,json:JSON.parse(s),body:s})}catch{r({status:res.statusCode,body:s})}})});rq.on('error',j);if(d)rq.write(d);rq.end();});}

function paramsSummary(p) {
  if (!p || typeof p !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(p).slice(0, 6)) {
    if (k === 'cells' && v && typeof v === 'object') {
      const addrs = Object.keys(v).slice(0, 3);
      parts.push(`cells={${addrs.join(',')}${Object.keys(v).length > 3 ? ',+'+(Object.keys(v).length-3) : ''}}`);
    } else if (Array.isArray(v)) parts.push(`${k}[${v.length}]`);
    else if (typeof v === 'string') parts.push(`${k}="${v.slice(0, 30)}${v.length > 30 ? '…' : ''}"`);
    else if (typeof v === 'object' && v) parts.push(`${k}={…}`);
    else parts.push(`${k}=${v}`);
  }
  return parts.join(' ');
}

(async()=>{
  const link=await req('POST',process.env.SUPABASE_URL+'/auth/v1/admin/generate_link',{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+process.env.SUPABASE_SERVICE_ROLE_KEY},{type:'magiclink',email:'francescojordan04@gmail.com'});
  const otp=link.json?.email_otp||link.json?.properties?.email_otp;
  const v=await req('POST',process.env.SUPABASE_URL+'/auth/v1/verify',{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY},{type:'magiclink',email:'francescojordan04@gmail.com',token:otp});
  const tok=v.json.access_token;
  const tid='turn-1780391615871-zkq1jsd4';

  const turn=await req('GET','https://excel-six-plum.vercel.app/api/turn/'+tid,{Authorization:'Bearer '+tok});
  const tr=await req('GET','https://excel-six-plum.vercel.app/api/turn/'+encodeURIComponent(tid)+'/llm-traces?limit=5000&order=asc',{Authorization:'Bearer '+tok});
  const recs=Array.isArray(tr.json)?tr.json:(tr.json.records||tr.json.traces||[]);
  const resps=recs.filter(r=>r.eventType==='llm.response');
  const reqs=recs.filter(r=>r.eventType==='llm.request');

  console.log('=== VAIRANO E2E ANALYSIS ===');
  console.log(`Turn: ${tid}`);
  console.log(`Final status: ${turn.json?.status}`);
  console.log(`Final error: ${turn.json?.error || 'none'}`);
  console.log(`LLM calls: ${resps.length}`);

  // Per-label breakdown
  const byLabel={};
  for(const r of resps){byLabel[r.label]=(byLabel[r.label]||0)+1}
  console.log('\nLabels (top 20):');
  Object.entries(byLabel).sort((a,b)=>b[1]-a[1]).slice(0,20).forEach(([l,c])=>console.log(`  ${String(c).padStart(3)} ${l}`));

  // Per-slice iter counts
  const sliceIters={};
  for(const r of resps){
    const m=r.label.match(/AgentStep iter (\d+)/);
    if(m){const it=Number(m[1]); /* group by label prefix? */}
  }

  // Total tokens
  const totalIn=resps.reduce((a,r)=>a+(r.usage?.prompt_tokens||0),0);
  const totalOut=resps.reduce((a,r)=>a+(r.usage?.completion_tokens||0),0);
  const totalMs=resps.reduce((a,r)=>a+(r.latencyMs||r.latency_ms||0),0);
  console.log(`\nTokens: in=${totalIn.toLocaleString()} out=${totalOut.toLocaleString()} total=${(totalIn+totalOut).toLocaleString()}`);
  console.log(`Latency sum: ${Math.round(totalMs/1000)}s`);

  // Tool call frequency from parsed responses
  const tools={};
  const errors=[];
  for(const r of resps){
    try {
      const j=JSON.parse(r.responseText||r.response_text||r.response||'{}');
      if(j.tool){tools[j.tool]=(tools[j.tool]||0)+1}
    } catch(e){errors.push({label:r.label,err:e.message.slice(0,80)})}
  }
  console.log('\nTool counts:');
  Object.entries(tools).sort((a,b)=>b[1]-a[1]).forEach(([t,c])=>console.log(`  ${String(c).padStart(3)} ${t}`));

  console.log(`\nParse errors (trace-level): ${errors.length}`);
  errors.slice(0,8).forEach(e=>console.log(`  ${e.label}: ${e.err}`));

  // Plan / tasks
  const tasks=turn.json?.plan?.tasks||[];
  console.log(`\nPlan: ${tasks.length} tasks`);
  for(const t of tasks){console.log(`  ${t.id||t.taskId}: status=${t.status||'?'}`);}

  // Iter-by-iter narrative (compressed)
  console.log('\n=== ITER-BY-ITER (compressed) ===');
  for(let i=0;i<resps.length;i++){
    const r=resps[i];
    let parsed;
    try{parsed=JSON.parse(r.responseText||'{}')}catch{parsed={_pe:1}}
    const tok=`${r.usage?.prompt_tokens||0}→${r.usage?.completion_tokens||0}`;
    const ms=r.latencyMs||r.latency_ms||0;
    let line=`[${String(i+1).padStart(3)}] ${r.label.padEnd(40)} tok ${tok} ${ms}ms`;
    if(parsed._pe) line+=' ✗parse';
    else if(parsed.tool) line+=' '+parsed.tool+'('+paramsSummary(parsed.params).slice(0,80)+')';
    console.log(line);
    if(parsed.thought){console.log('    '+parsed.thought.slice(0,180));}
  }
})().catch(e=>{console.error('ERR:',e.message);process.exit(1)});
