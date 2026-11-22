"use strict";
/* =====================================================================
   claude.ai 아티팩트 버전의 플랫폼 부분
   - AI: 페이지를 여는 사람의 Claude 계정 (sample 기능, 이미지 포함)
   - 저장: 아티팩트 저장소 (메타데이터는 db, 문항 이미지는 assets). 쓸 수 없으면 이 브라우저(IndexedDB)
   - 파일 저장: downloads 기능 (저장할 때마다 확인 창)
   함께 게시하는 파일: pdf.worker.min.js, cmaps.json (한글 CID 글꼴 매핑)
   ===================================================================== */
const PLATFORM = (() => {
  const caps = {sample: null, db: null, assets: null, downloads: null, images: null, tier: "complex", blocked: ""};
  const AI_COPY = {
    not_granted: "이 페이지에서 Claude 사용이 허용되지 않았습니다. 다시 쓰려면 페이지를 새로고침한 뒤 허용하세요.",
    sampling_disabled: "이 계정에서는 Claude를 쓸 수 없습니다.",
    capability_disabled: "이 화면에서는 Claude를 쓸 수 없습니다.",
    capability_removed: "이 앱 버전에서는 Claude를 쓸 수 없습니다. 앱을 업데이트하세요.",
    not_declared: "이 화면에서는 Claude를 쓸 수 없습니다.",
    images_unavailable: "이 화면에서는 Claude에게 이미지를 보낼 수 없습니다.",
    rate_limited: "요청이 많아 잠시 쉬어야 합니다. 조금 뒤 다시 눌러 주세요.",
    session_expired: "로그인이 만료되었습니다. 다시 로그인하세요.",
    image_rejected: "이미지를 보낼 수 없었습니다.",
    refused: "Claude가 이 요청을 거절했습니다.",
    empty_completion: "Claude가 빈 답을 보냈습니다. 다시 눌러 주세요.",
    invalid_json: "응답 형식이 맞지 않았습니다. 다시 눌러 주세요.",
    prompt_too_large: "보낼 내용이 너무 깁니다.",
    cancelled: "취소했습니다.",
  };
  const BLOCKING = new Set(["not_granted", "sampling_disabled", "capability_disabled", "capability_removed", "not_declared", "images_unavailable"]);
  const ready = () => !!caps.sample && !!caps.images && !caps.blocked;

  async function ask({system, text, images = [], schema, tier, fresh = false}) {
    if (!ready()) throw new Error(caps.blocked || AI_COPY.capability_disabled);
    const opts = {modelTier: tier === "default" ? "default" : caps.tier};
    if (images.length) opts.images = images;
    if (fresh) opts.cache = false;
    try {
      return await caps.sample.json(`${system}\n\n${text}${schemaInstruction(schema)}`, opts);
    } catch (e) {
      const code = e?.code || "upstream_error";
      let msg = AI_COPY[code] || "Claude 호출 중 일시적인 오류가 났습니다. 다시 눌러 주세요.";
      if (code === "rate_limited" && e.reason === "usage_limit") msg = "Claude 사용 한도에 도달했습니다. 한도가 풀린 뒤 다시 시도하세요.";
      if (BLOCKING.has(code)) { caps.blocked = msg; updateStatus(); }
      throw new Error(msg);
    }
  }

  /* ---------- 공유 저장소: db + assets ---------- */
  function cloudStore(db, assets) {
    const chains = new Map();
    const queue = (key, fn) => { const p = (chains.get(key) || Promise.resolve()).catch(() => {}).then(fn); chains.set(key, p); return p; };
    const plain = o => JSON.parse(JSON.stringify(o));
    const loaded = {exams: false, problems: false};
    return {
      kind: "cloud", readOnly: !assets,
      ready: () => loaded.exams && loaded.problems,
      describe: () => "이 아티팩트의 저장소에 보관합니다. 다른 기기에서 열어도 그대로 보이고, 아티팩트를 공유받은 사람도 볼 수 있습니다." + (assets ? "" : " 지금은 보기 전용입니다."),
      start(onChange) {
        const timer = setTimeout(() => { if (!this.ready()) toast("저장소에 아직 연결되지 않았습니다. 인터넷 연결을 확인하세요."); }, 10000);
        const done = (k, snap) => { if (!snap.metadata.fromCache) loaded[k] = true; if (this.ready()) clearTimeout(timer); onChange(); };
        db.collection("exams").onSnapshot(snap => {
          state.exams = new Map(snap.docs.map(d => [d.id, {...d.data(), id: d.id}])); done("exams", snap);
        }, e => { clearTimeout(timer); toast("저장소 오류: " + e.code); });
        db.collection("made").onSnapshot(snap => { state.made = new Map(snap.docs.map(d => [d.id, {...d.data(), id: d.id}])); onChange(); }, () => {});
        db.collection("problems").onSnapshot(snap => {
          state.problems = new Map(snap.docs.map(d => { const v = upgradeProblem({...d.data(), id: d.id}); v.image = "/_blob/" + v.imageId; return [d.id, v]; }));
          done("problems", snap);
        }, e => { clearTimeout(timer); toast("저장소 오류: " + e.code); });
      },
      async reload() { /* 아티팩트 저장소는 바뀔 때마다 실시간으로 받아 오므로 다시 그리기만 한다 */ },
      async saveImage(id, blob) { const r = await assets.upload(blob); return {imageId: r.id, image: r.url}; },
      putExam(e) { state.exams.set(e.id, e); return queue("e/" + e.id, () => db.collection("exams").doc(e.id).set(plain(e))); },
      putProblem(p) {
        state.problems.set(p.id, p);
        const {image, ...rest} = p;
        return queue("p/" + p.id, () => db.collection("problems").doc(p.id).set(plain(rest)));
      },
      async deleteProblem(p) {
        state.problems.delete(p.id); state.selected.delete(p.id);
        await queue("p/" + p.id, () => db.collection("problems").doc(p.id).delete());
        if (p.imageId) await assets.delete(p.imageId).catch(() => {});
      },
      async deleteExam(id) {
        for (const p of [...state.problems.values()].filter(p => p.examId === id)) await this.deleteProblem(p);
        state.exams.delete(id);
        await queue("e/" + id, () => db.collection("exams").doc(id).delete());
      },
      putMade(m) { state.made.set(m.id, m); return queue("m/" + m.id, () => db.collection("made").doc(m.id).set(plain(m))); },
      async deleteMade(id) { state.made.delete(id); await queue("m/" + id, () => db.collection("made").doc(id).delete()); },
    };
  }
  /* ---------- 저장소를 쓸 수 없을 때: 이 브라우저(IndexedDB) ---------- */
  function localStore() {
    let dbh = null, loaded = false;
    const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const os = (n, m) => dbh.transaction(n, m).objectStore(n);
    return {
      kind: "local", readOnly: false, ready: () => loaded,
      describe: () => "이 브라우저 안에만 저장합니다. 브라우저 데이터를 지우면 사라지니 가끔 ZIP 으로 저장하세요.",
      async start(onChange) {
        try {
          dbh = await new Promise((res, rej) => {
            const r = indexedDB.open("mathgen", 2); // 2판: 만든 문제 보관함(made) 추가
            r.onupgradeneeded = () => { for (const n of ["exams", "problems", "made"]) if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n, {keyPath: "id"}); };
            r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
          });
          for (const e of await req(os("exams", "readonly").getAll())) state.exams.set(e.id, e);
          for (const p of await req(os("problems", "readonly").getAll())) state.problems.set(p.id, upgradeProblem(p));
          for (const m of await req(os("made", "readonly").getAll())) state.made.set(m.id, m);
        } catch (e) { dbh = null; }
        loaded = true; onChange();
      },
      // 저장소를 처음부터 다시 읽는다 (다른 탭·창에서 바꾼 내용 반영)
      async reload() {
        if (!dbh) return;
        const [es, ps, ms] = await Promise.all(["exams", "problems", "made"].map(n => req(os(n, "readonly").getAll())));
        state.exams = new Map(es.map(e => [e.id, e]));
        state.problems = new Map(ps.map(p => [p.id, upgradeProblem(p)]));
        state.made = new Map(ms.map(m => [m.id, m]));
      },
      async saveImage(id, blob) { return {image: await blobToDataURL(blob)}; },
      async putExam(e) { state.exams.set(e.id, e); if (dbh) await req(os("exams", "readwrite").put(e)).catch(() => {}); },
      async putProblem(p) { state.problems.set(p.id, p); if (dbh) await req(os("problems", "readwrite").put(p)).catch(() => {}); },
      async deleteProblem(p) { state.problems.delete(p.id); state.selected.delete(p.id); if (dbh) await req(os("problems", "readwrite").delete(p.id)).catch(() => {}); },
      async deleteExam(id) {
        for (const p of [...state.problems.values()].filter(p => p.examId === id)) await this.deleteProblem(p);
        state.exams.delete(id); if (dbh) await req(os("exams", "readwrite").delete(id)).catch(() => {});
      },
      async putMade(m) { state.made.set(m.id, m); if (dbh) await req(os("made", "readwrite").put(m)).catch(() => {}); },
      async deleteMade(id) { state.made.delete(id); if (dbh) await req(os("made", "readwrite").delete(id)).catch(() => {}); },
    };
  }

  // 한글 CID 글꼴의 문자 매핑(CMap)은 cmaps.json 하나에 묶어 두고 필요할 때 읽는다
  let cmapPack = null;
  class PackedCMapReader {
    async fetch({name}) {
      cmapPack = cmapPack || fetch("cmaps.json").then(r => { if (!r.ok) throw new Error("cmaps.json " + r.status); return r.json(); });
      const b64 = (await cmapPack)[name];
      if (!b64) throw new Error("CMap 없음: " + name);
      const bin = atob(b64), data = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      return {cMapData: data, compressionType: 1};
    }
  }

  const P = {
    name: "artifact",
    pdfWorker: "pdf.worker.min.js",
    pdfParams: () => ({CMapReaderFactory: PackedCMapReader}),
    async init() {
      const use = n => (window.claude?.use ? window.claude.use(n).catch(() => null) : Promise.resolve(null));
      const [sample, db, assets, downloads] = await Promise.all(["sample", "db", "assets", "downloads"].map(use));
      Object.assign(caps, {sample, db, assets, downloads});
      if (sample) {
        const lim = await sample.limits().catch(() => null);
        caps.images = lim?.images || null;
        caps.tier = (lim?.modelTiers || ["default", "complex", "quick"]).includes("complex") ? "complex" : "default";
      }
      P.store = db ? cloudStore(db, assets) : localStore();
    },
    ai: {
      ready,
      label: () => "Claude (내 계정)",
      blockedReason: short => short ? (caps.sample ? "Claude 사용 불가" : "AI 없이 사용 중")
        : caps.blocked || (caps.sample ? AI_COPY.images_unavailable : "이 화면에서는 Claude 를 쓸 수 없습니다."),
      ask,
      batchSize: () => Math.max(1, Math.min(3, caps.images?.maxCount || 1)),
      concurrency: () => 2,
    },
    store: {kind: "pending", readOnly: true, ready: () => false, describe: () => "확인 중…", start() {}},
    canSave: () => !!caps.downloads,
    async saveFile(filename, data) {
      if (!caps.downloads) throw new Error("이 화면에서는 파일을 저장할 수 없습니다");
      try { await caps.downloads.save({filename, data}); return true; }
      catch (e) { if (e?.code === "declined") return false; throw new Error(e?.code || "오류"); }
    },
    folderSave: null,
    folderWatch: false,
    settings: {
      label: "정보",
      render(root) {
        root.innerHTML = `<div class="panel">
          <h2 style="font-size:18px;margin-bottom:6px">Claude</h2>
          <p>${ready() ? `<span class="chip ok">연결됨</span> 한 번에 이미지 최대 ${caps.images.maxCount}장을 보냅니다.` : `<span class="chip warn">사용 불가</span> ${esc(P.ai.blockedReason())}`}</p>
          <p class="muted">단원 분류, 풀이, 문제 생성은 이 페이지를 여는 사람의 Claude 계정 사용량으로 진행됩니다. 처음 쓸 때 허용할지 묻습니다.
            다른 AI(OpenAI, Gemini)나 API 키를 쓰려면 다운로드 버전(mathgen.html)을 쓰세요.</p></div>`;
      },
    },
  };
  return P;
})();
