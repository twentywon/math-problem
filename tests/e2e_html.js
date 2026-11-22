// mathgen.html 브라우저 테스트 (Playwright). CDN 은 로컬 npm 패키지로, Claude API 는 가짜 SSE 응답으로 대체한다.
// 사용: node tests/e2e_html.js <작업폴더(k/ 에 katex, pdfjs, jszip 패키지, sample.pdf)> <mathgen.html 절대경로>
const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs');
const S = process.argv[2], HTML = process.argv[3];
const K = S + '/k';
function local(url){
  if (url.includes('katex@0.16.11/')) return K + '/package/' + url.split('katex@0.16.11/')[1];
  if (url.includes('pdf.js/3.11.174/')) return K + '/pdfjs/package/' + (url.split('3.11.174/')[1].startsWith('cmaps')||url.split('3.11.174/')[1].startsWith('standard_fonts') ? '' : 'build/') + url.split('3.11.174/')[1];
  if (url.includes('jszip/3.10.1/')) return K + '/jszip/package/dist/jszip.min.js';
}
function sse(obj){
  const text = JSON.stringify(obj); const half = Math.floor(text.length/2);
  const ev = (t,d)=>`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`;
  return ev('message_start',{type:'message_start',message:{id:'m',type:'message',content:[]}})
    + ev('content_block_start',{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}})
    + ev('content_block_stop',{type:'content_block_stop',index:0})
    + ev('content_block_start',{type:'content_block_start',index:1,content_block:{type:'text',text:''}})
    + ev('content_block_delta',{type:'content_block_delta',index:1,delta:{type:'text_delta',text:text.slice(0,half)}})
    + ev('content_block_delta',{type:'content_block_delta',index:1,delta:{type:'text_delta',text:text.slice(half)}})
    + ev('content_block_stop',{type:'content_block_stop',index:1})
    + ev('message_delta',{type:'message_delta',delta:{stop_reason:'end_turn'}})
    + ev('message_stop',{type:'message_stop'});
}
const units = ['CM1-2-2','ALG-1-1','CAL1-2-2','PS-2-2','CAL2-1-2'];
let calls = [], n = 0;
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({viewport:{width:1280,height:900}, acceptDownloads:true});
  const errors = [];
  await ctx.route(/cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/, async r => {
    const f = local(r.request().url());
    if (f && fs.existsSync(f)) return r.fulfill({path:f, headers:{'access-control-allow-origin':'*'}});
    console.log('MISSING', r.request().url()); r.fulfill({status:404});
  });
  await ctx.route('https://api.anthropic.com/**', async r => {
    const req = r.request(); const body = JSON.parse(req.postData()); const h = req.headers();
    calls.push({h, body});
    const sys = body.system[0].text; let out;
    if (sys.includes('검토자')) out = {answer: body.messages[0].content[0].text.includes('B형') ? '2' : '③', well_posed:true, issues:'', solution_brief:'...'};
    else if (sys.includes('출제 경험')) out = {problems:[
      {kind:'유사문제',title:'인수분해로 근 찾기',statement:'이차방정식 $x^2-5x+6=0$ 의 두 근 중 큰 근은?',choices:['$1$','$2$','$3$','$4$','$5$'],figure_description:'',answer:'3',solution:'$(x-2)(x-3)=0$ 이므로 $3$',shared_concepts:['인수분해'],relation_to_original:'수치 변경',unit_id:'CM1-2-1',difficulty:2},
      {kind:'개념연계문제',title:'B형 문제',statement:'$\\sum_{k=1}^{n} k = 55$ 일 때 $n$ 은?',choices:[],figure_description:'',answer:'10',solution:'$n(n+1)/2=55$',shared_concepts:['식 세우기'],relation_to_original:'같은 접근법',unit_id:'ALG-3-2',difficulty:3}]};
    else out = {transcription:'함수 $f(x)=x^2$ ...',figure_description:'',question_type:'5지선다',primary_unit_id:units[(n++)%units.length],secondary_unit_ids:[],key_concepts:['근과 계수의 관계'],solution_approach:'인수분해한다.',answer:'3',solution:'...',difficulty:3};
    await r.fulfill({status:200, headers:{'content-type':'text/event-stream','access-control-allow-origin':'*','access-control-allow-headers':'*'}, body: sse(out)});
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror: '+e.message));
  page.on('console', m => { if (m.type()==='error') errors.push('console: '+m.text()); });
  await page.goto('file://' + HTML);
  // 설정
  await page.click('nav button[data-tab=settings]');
  await page.fill('#s-key','sk-ant-test'); await page.click('#s-save');
  await page.click('nav button[data-tab=ingest]');
  await page.setInputFiles('#file', S + '/sample.pdf');
  await page.waitForFunction(() => document.querySelector('.status')?.textContent.includes('분류 완료') || document.querySelector('.status')?.textContent.includes('오류'), null, {timeout:60000});
  console.log('STATUS:', await page.textContent('.status'));
  console.log('LOG:', (await page.textContent('.log')).split('\n').slice(0,8).join(' | '));
  console.log('crops:', await page.locator('.crops .pcard').count());
  await page.screenshot({path: S+'/h1.png'});
  // 저장소
  await page.click('nav button[data-tab=library]');
  await page.waitForTimeout(300);
  console.log('grid:', await page.locator('#grid .pcard').count(), '|', await page.textContent('#lib-status'));
  await page.locator('#tree .node', {hasText:'대수'}).first().click();
  console.log('filtered:', await page.textContent('#lib-status'));
  await page.locator('#tree .node').first().click();
  await page.screenshot({path: S+'/h2.png'});
  await page.locator('#grid .pcard').first().click();
  await page.click('#detail .gen');
  await page.waitForFunction(() => /만들었습니다|오류/.test(document.querySelector('#detail .genmsg').textContent), null, {timeout:30000});
  console.log('GEN:', await page.textContent('#detail .genmsg'));
  await page.waitForTimeout(800);
  await page.locator('#detail .gens details').first().evaluate(d => d.open = true);
  console.log('katex in dialog:', await page.locator('#detail .katex').count());
  await page.screenshot({path: S+'/h3.png'});
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#detail .sheet')]);
  await dl.saveAs(S + '/sheet.html');
  await page.click('#detail .close');
  const [z] = await Promise.all([page.waitForEvent('download'), page.click('#btn-zip')]);
  await z.saveAs(S + '/export.zip');
  // 새로고침 후 유지 확인
  await page.reload(); await page.click('nav button[data-tab=library]'); await page.waitForTimeout(300);
  console.log('after reload:', await page.textContent('#lib-status'));
  const h = calls[0].h;
  console.log('headers:', h['anthropic-version'], h['anthropic-beta'], h['anthropic-dangerous-direct-browser-access'], 'fallbacks=', calls[0].body.fallbacks, 'calls=', calls.length);
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
  await b.close();
})();
