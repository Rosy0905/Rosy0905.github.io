/* ================================================================
   sync-hub.js · 主站数据同步（四站统一备份）
   ----------------------------------------------------------------
   四个子站同在 rosy0905.github.io 域名下，localStorage / IndexedDB
   天然共享，所以主站可以直接代读代写，不需要各站配合。

   存储分布：
   - 经济学  localStorage：eco_kb_* / 各模块前缀 / custom_* / ai_assistant_* / ai_cards_*
   - 阅读    localStorage：ekz* / drawn.*（画笔偏好）  IndexedDB：ekz-notes-v2、ekz-notes-db（旧库）
   - 单词    localStorage：dkz.*（chk/mode/pos/view/q 五个键）
   - 数学    localStorage：studyMath*   IndexedDB：study-math-v3（problems/status）

   导出格式：{ app:'study-hub-backup', version:1, exportedAt, sites:{...} }
   导入语义：备份里带的 key / 记录整块覆盖，本机有而备份没有的不动。
   AI 配置里的 API Key 导出时剔除，导入时保留本机已有的。
   清除：按站点前缀删 localStorage 对应键，并整库删除 IndexedDB。
   ================================================================ */
(function () {
  'use strict';

  /* ---------- 站点定义 ---------- */
  /* 顺序即导出/清除弹窗里的排列：经济学、数三、真题、单词 */
  var SITES = [
    {
      id: 'econ', name: '南开经济学 · 知识库', short: '经济学',
      lsPrefix: ['eco_kb_', 'micro_recite_', 'macro_recite_', 'calc_key_',
                 'calc_special_', 'micro_short_', 'macro_short_', 'essay_',
                 'past_exams_', 'custom_cards_', 'custom_chapters_',
                 'ai_assistant_', 'ai_cards_'],
      dbs: []
    },
    {
      id: 'math', name: '数学三 · 精选错题', short: '数学三',
      lsPrefix: ['studyMath'],
      /* studyMathSeedVer 是题库版本号（题库重灌的判断依据），不是学习数据：
         计数与代清都跳过，删了会触发整库重灌，多此一举 */
      lsExclude: ['studyMathSeedVer'],
      /* problems 表是随站发行的题库（种子灌入），status 表才是正误标记。
         代清与站内「清空正误」对齐：只清 status，题库保留 */
      dataStores: ['status'],
      dbs: ['study-math-v3']
    },
    {
      id: 'reading', name: '英语一 · 真题阅读', short: '英语阅读',
      /* drawn.* 是阅读站画笔工具栏的三个偏好键，不在 ekz 前缀里 */
      lsPrefix: ['ekz', 'drawn.'],
      /* ekz-wiped-<id> 是阅读站清空后故意留的防复活记号（拦着开着的标签页把
         内存里的旧笔迹写回来），只带一个时间戳，不是用户数据。
         收集 / 导出 / 计数 / 主站代清都跳过它，记号只有阅读站自己能删 */
      lsExclude: ['ekz-wiped-'],
      /* ekz-notes-db 是迁移前的旧库，阅读站自己清空时也会删它，
         不删会在下次迁移时把笔记灌回来 */
      dbs: ['ekz-notes-v2', 'ekz-notes-db']
    },
    {
      id: 'words', name: '英语一 · 单词速刷', short: '单词速刷',
      /* 单词站现有 5 个键：dkz.chk.v1 / dkz.mode.v1 / dkz.pos.v1 / dkz.view.v1
         / dkz.q.v1（2026-10-25 更新新增 q，搜索词持久化），dkz. 前缀全覆盖 */
      lsPrefix: ['dkz.'],
      dbs: []
    }
  ];

  var AI_CFG_PREFIX = 'ai_assistant_cfg_';

  /* 键是否属于某站：前缀命中，且不在该站的排除名单里 */
  function lsHit(k, site) {
    if (site.lsExclude && site.lsExclude.some(function (p) { return k.indexOf(p) === 0; })) return false;
    return site.lsPrefix.some(function (p) { return k.indexOf(p) === 0; });
  }

  function siteById(id) {
    for (var i = 0; i < SITES.length; i++) if (SITES[i].id === id) return SITES[i];
    return null;
  }

  /* ---------- 小工具 ---------- */
  function utf8Len(str) {
    var n = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }
  function fmtSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(2) + ' MB';
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function $(id) { return document.getElementById(id); }

  /* ---------- IndexedDB 读取：整库全量（onlyStores 给了就只读这些表） ---------- */
  function idbDump(dbName, onlyStores) {
    return new Promise(function (res) {
      var openReq = indexedDB.open(dbName);
      openReq.onerror = function () { res({ __missing: true }); };
      openReq.onsuccess = function () {
        var db = openReq.result;
        var out = {};
        var names = Array.prototype.slice.call(db.objectStoreNames);
        /* 有 dataStores 的站只读数据表：题库是随站内容，备份只带学习数据 */
        if (onlyStores && onlyStores.length) {
          names = names.filter(function (n) { return onlyStores.indexOf(n) >= 0; });
        }
        if (!names.length) { db.close(); res(out); return; }
        var left = names.length;
        names.forEach(function (store) {
          try {
            var rq = db.transaction(store, 'readonly').objectStore(store).getAll();
            rq.onsuccess = function () {
              out[store] = rq.result || [];
              if (--left === 0) { db.close(); res(out); }
            };
            rq.onerror = function () {
              out[store] = [];
              if (--left === 0) { db.close(); res(out); }
            };
          } catch (e) {
            out[store] = [];
            if (--left === 0) { db.close(); res(out); }
          }
        });
      };
    });
  }

  /* ---------- IndexedDB 写入：按记录 put 覆盖 ---------- */
  function idbRestore(dbName, data) {
    return new Promise(function (res, rej) {
      var openReq = indexedDB.open(dbName);
      openReq.onerror = function () { rej(openReq.error || new Error('打不开数据库 ' + dbName)); };
      openReq.onupgradeneeded = function (ev) {
        /* 本机没这个库时，按备份里的结构建 */
        var db = ev.target.result;
        Object.keys(data).forEach(function (s) {
          if (!db.objectStoreNames.contains(s)) {
            try { db.createObjectStore(s, { keyPath: 'id' }); } catch (e) {}
          }
        });
      };
      openReq.onsuccess = function () {
        var db = openReq.result;
        var names = Array.prototype.slice.call(db.objectStoreNames);
        var jobs = [];
        Object.keys(data).forEach(function (store) {
          var rows = data[store];
          if (!Array.isArray(rows) || !rows.length) return;
          if (names.indexOf(store) < 0) return; /* 建不出来的 store 跳过，不阻断其他 */
          jobs.push(new Promise(function (ok, no) {
            var tx = db.transaction(store, 'readwrite');
            tx.oncomplete = ok;
            tx.onerror = function () { no(tx.error); };
            tx.onabort = function () { no(tx.error || new Error('写入被中止')); };
            try {
              var st = tx.objectStore(store);
              rows.forEach(function (r) { try { st.put(r); } catch (e) {} });
            } catch (e) { try { tx.abort(); } catch (_) {} no(e); }
          }));
        });
        Promise.all(jobs.map(function (p) {
          return p.then(function () { return null; }, function (e) { return e; });
        })).then(function (errs) {
          db.close();
          var bad = errs.filter(Boolean);
          if (bad.length) rej(bad[0]); else res();
        });
      };
    });
  }

  /* ---------- 收集本机数据 ---------- */
  function collectLs(site) {
    var out = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k) continue;
        var hit = lsHit(k, site);
        if (!hit) continue;
        var v = localStorage.getItem(k);
        if (typeof v === 'string') out[k] = v;
      }
    } catch (e) {}
    return out;
  }

  function collectSite(site) {
    var pack = { localStorage: collectLs(site) };
    if (site.dbs.length) {
      pack.indexedDB = {};
      site.dbs.forEach(function (d) { pack.indexedDB[d] = null; });
    }
    return pack;
  }

  /* ---------- 统计条数 / 体积 ---------- */
  function countOf(pack) {
    var n = Object.keys(pack.localStorage || {}).length;
    if (pack.indexedDB) {
      Object.keys(pack.indexedDB).forEach(function (db) {
        var stores = pack.indexedDB[db] || {};
        Object.keys(stores).forEach(function (s) {
          if (Array.isArray(stores[s])) n += stores[s].length;
        });
      });
    }
    return n;
  }
  function bytesOf(pack) {
    var n = 0;
    Object.keys(pack.localStorage || {}).forEach(function (k) {
      n += utf8Len(k) + utf8Len(pack.localStorage[k]) + 8;
    });
    if (pack.indexedDB) {
      Object.keys(pack.indexedDB).forEach(function (db) {
        n += utf8Len(db);
        var stores = pack.indexedDB[db] || {};
        Object.keys(stores).forEach(function (s) {
          if (Array.isArray(stores[s])) n += utf8Len(JSON.stringify(stores[s]));
        });
      });
    }
    return n;
  }

  /* ================================================================
     UI：右上角花心处的同步 dock
     ================================================================ */
  var dock = $('syncDock');
  var orbBtn = $('syncOrbBtn');
  var orbImport = $('syncOrbImport');
  var orbExport = $('syncOrbExport');
  var orbClear = $('syncOrbClear');
  var fileInput = $('syncFile');
  var exportOverlay = $('syncExportOverlay');
  var importOverlay = $('syncImportOverlay');
  var clearOverlay = $('syncClearOverlay');
  var toastEl = $('syncToast');

  var isOpen = false;

  /* 小球距离自适应：按主球上方/下方的可用空间动态定距，
     空间不够就把整个 dock 下移，保证导入球不飞出屏幕 */
  function layoutOrbs() {
    var half = (orbImport.offsetHeight || 36) / 2;
    var gap = 8;
    var r = dock.getBoundingClientRect();
    var dist = Math.min(54, Math.max(40,
      Math.min(r.top, window.innerHeight - r.bottom) - half - gap));
    var needTop = dist + half + gap;
    if (r.top < needTop) dock.style.top = needTop + 'px';
    dock.style.setProperty('--orb-dist', dist + 'px');
  }

  function openDock() {
    isOpen = true;
    dock.classList.add('open');
    orbBtn.setAttribute('aria-expanded', 'true');
    layoutOrbs();
  }
  function closeDock() {
    isOpen = false;
    dock.classList.remove('open');
    orbBtn.setAttribute('aria-expanded', 'false');
    dock.style.top = '';
  }
  /* 开弹窗 / 弹文件框时用的瞬收：三个小球那 0.4s 弹性收起动画，
     在弹窗半透明模糊背景后面照样看得见，像先闪一下别的东西。
     这里先摘掉过渡再收起，强制回流后还回去，视觉上就是点完直接出面板。 */
  function closeDockInstant() {
    dock.classList.add('no-anim');
    closeDock();
    void dock.offsetWidth;
    dock.classList.remove('no-anim');
  }
  orbBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (isOpen) closeDock(); else openDock();
  });
  document.addEventListener('click', function (e) {
    if (!isOpen) return;
    if (dock.contains(e.target)) return;
    closeDock();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (exportOverlay.classList.contains('show')) closeExportDialog();
      else if (importOverlay.classList.contains('show')) closeImportDialog();
      else if (clearOverlay.classList.contains('show')) closeClearDialog();
      else if (isOpen) closeDock();
    }
  });

  /* 三个小球都支持键盘回车 / 空格 */
  [orbImport, orbExport, orbClear].forEach(function (orb) {
    orb.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        orb.click();
      }
    });
  });
  window.addEventListener('resize', function () { if (isOpen) layoutOrbs(); });

  var toastTimer = null;
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
  }

  /* ================================================================
     导出
     ================================================================ */
  /* 统一的站数据统计：localStorage（含排除名单）+ IndexedDB 真读。
     IDB 按 dataStores 过滤——题库是内容，不算用户的记录（数学站只数 status）。
     导出弹窗和清除弹窗共用，避免两边口径不一样把站误判成空。 */
  var statsCache = {};
  function siteStats(s) {
    var pack = collectSite(s);
    var cnt = countOf(pack);
    var bytes = bytesOf(pack);
    if (!s.dbs.length) { statsCache[s.id] = bytes; return Promise.resolve({ cnt: cnt, bytes: bytes }); }
    return Promise.all(s.dbs.map(function (d) { return idbDump(d, s.dataStores); }))
      .then(function (dumps) {
        dumps.forEach(function (data) {
          if (!data || data.__missing) return;
          Object.keys(data).forEach(function (st) {
            if (Array.isArray(data[st])) { cnt += data[st].length; bytes += utf8Len(JSON.stringify(data[st])); }
          });
        });
        statsCache[s.id] = bytes;
        return { cnt: cnt, bytes: bytes };
      });
  }

  function openExportDialog() {
    closeDockInstant();
    var list = $('syncSiteList');
    list.innerHTML = '<p style="margin-top:4px;font-size:12px;color:#8A92B4">正在统计…</p>';
    exportOverlay.classList.add('show');
    Promise.all(SITES.map(function (s) {
      return siteStats(s).then(function (st) { return { s: s, cnt: st.cnt, bytes: st.bytes }; });
    })).then(function (rows) {
      list.innerHTML = '';
      rows.forEach(function (r) {
        var s = r.s, cnt = r.cnt;
        var row = document.createElement('label');
        row.className = 'sync-site' + (cnt ? ' chk' : ' is-empty');
        row.innerHTML =
          '<input type="checkbox" data-site="' + s.id + '"' + (cnt ? ' checked' : ' disabled') + '>' +
          '<span class="sync-tick"></span>' +
          '<span class="sync-site-txt"><b>' + s.name + '</b>' +
          '<i>' + (cnt ? cnt + ' 条记录 · ' + fmtSize(r.bytes) : '本机暂无数据') + '</i></span>';
        list.appendChild(row);
      });
      refreshExportSize();
    });
  }

  function currentPick() {
    var ids = [];
    exportOverlay.querySelectorAll('input[data-site]').forEach(function (cb) {
      if (cb.checked) ids.push(cb.getAttribute('data-site'));
    });
    return ids;
  }
  function refreshExportSize() {
    var total = 160;
    currentPick().forEach(function (id) {
      var s = siteById(id);
      if (!s) return;
      total += (statsCache[id] != null ? statsCache[id] : bytesOf(collectSite(s)));
    });
    $('syncExportSize').innerHTML = '预计文件大小：<b>' + fmtSize(total) + '</b>';
  }
  exportOverlay.addEventListener('change', refreshExportSize);

  function closeExportDialog() { exportOverlay.classList.remove('show'); }
  $('syncExportCancel').addEventListener('click', closeExportDialog);
  exportOverlay.addEventListener('click', function (e) {
    if (e.target === exportOverlay) closeExportDialog();
  });

  function stripKey(k, v) {
    /* AI 配置剔除 API Key，防止泄露 */
    if (k.indexOf(AI_CFG_PREFIX) !== 0) return v;
    try {
      var cfg = JSON.parse(v);
      if (cfg && typeof cfg === 'object') {
        delete cfg.key;
        return JSON.stringify(cfg);
      }
    } catch (e) {}
    return v;
  }

  $('syncExportOk').addEventListener('click', async function () {
    var ids = currentPick();
    if (!ids.length) { showToast('至少勾选一个站'); return; }

    var sitesPack = {};
    var totalCount = 0;
    for (var i = 0; i < ids.length; i++) {
      var s = siteById(ids[i]);
      var pack = collectSite(s);
      var ls = {};
      Object.keys(pack.localStorage).forEach(function (k) {
        ls[k] = stripKey(k, pack.localStorage[k]);
      });
      pack.localStorage = ls;
      if (s.dbs.length) {
        pack.indexedDB = {};
        for (var j = 0; j < s.dbs.length; j++) {
          pack.indexedDB[s.dbs[j]] = await idbDump(s.dbs[j], s.dataStores);
        }
      }
      sitesPack[s.id] = pack;
      totalCount += countOf(pack);
    }
    if (!totalCount) { showToast('选中的站都没有数据'); return; }

    var now = new Date();
    var payload = {
      app: 'study-hub-backup',
      version: 1,
      exportedAt: now.toISOString(),
      sites: sitesPack
    };
    var jsonText = JSON.stringify(payload);
    var name = 'Study全项目-备份-'
      + now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate())
      + '-' + pad2(now.getHours()) + pad2(now.getMinutes()) + '.json';

    var blob = new Blob([jsonText], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 2000);

    closeExportDialog();
    showToast('导出成功！' + totalCount + ' 条记录已保存');
  });

  /* ================================================================
     导入
     ================================================================ */
  orbImport.addEventListener('click', function () {
    closeDockInstant();
    fileInput.click();
  });
  orbExport.addEventListener('click', openExportDialog);

  fileInput.addEventListener('change', function () {
    var f = fileInput.files && fileInput.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = async function (ev) {
      var obj = null;
      try { obj = JSON.parse(ev.target.result); }
      catch (e) { showToast('导入失败：不是有效的 JSON 文件'); return; }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        showToast('导入失败：文件格式不正确'); return;
      }
      var sites = obj.sites;
      if (!sites || typeof sites !== 'object' || Array.isArray(sites)) {
        showToast('导入失败：不是主站的备份文件'); return;
      }
      /* 识别文件里有哪些站 */
      var found = [];
      Object.keys(sites).forEach(function (id) {
        var s = siteById(id);
        if (s) found.push({ site: s, pack: sites[id] });
      });
      if (!found.length) { showToast('文件里没有可识别的站点数据'); return; }

      /* 汇总说明 */
      var lines = [];
      var total = 0;
      found.forEach(function (it) {
        var cnt = countOf(it.pack);
        total += cnt;
        lines.push({ name: it.site.name, cnt: cnt });
      });
      openImportDialog(lines, total, found);
    };
    reader.readAsText(f);
    fileInput.value = '';
  });

  function openImportDialog(lines, total, found) {
    var box = $('syncImportSites');
    box.innerHTML = '';
    lines.forEach(function (l) {
      var row = document.createElement('div');
      row.className = 'sync-import-row';
      row.innerHTML = '<b>' + l.name + '</b><i>' + l.cnt + ' 条记录</i>';
      box.appendChild(row);
    });
    $('syncImportOk').onclick = async function () {
      closeImportDialog();
      var done = 0, errs = [];
      for (var i = 0; i < found.length; i++) {
        var s = found[i].site, pack = found[i].pack;
        /* localStorage */
        var ls = pack.localStorage || {};
        Object.keys(ls).forEach(function (k) {
          if (typeof ls[k] !== 'string') return;
          try {
            var v = ls[k];
            /* 导入 AI 配置时保留本机已有的 API Key */
            if (k.indexOf(AI_CFG_PREFIX) === 0) {
              try {
                var incoming = JSON.parse(v);
                var local = localStorage.getItem(k);
                if (local) {
                  try {
                    var mine = JSON.parse(local);
                    if (mine && typeof mine === 'object' && mine.key) incoming.key = mine.key;
                  } catch (e) {}
                }
                v = JSON.stringify(incoming);
              } catch (e) {}
            }
            localStorage.setItem(k, v);
            done++;
          } catch (e) { errs.push(s.short); }
        });
        /* IndexedDB */
        var dbs = pack.indexedDB || {};
        Object.keys(dbs).forEach(function (dbName) {
          var data = dbs[dbName];
          if (!data || data.__missing) return;
          idbRestore(dbName, data).then(function () {
            Object.keys(data).forEach(function (st) {
              if (Array.isArray(data[st])) done += data[st].length;
            });
          }, function (e) {
            errs.push(s.short + '（' + dbName + '）');
          });
        });
      }
      setTimeout(function () {
        if (errs.length) showToast('导入完成，但 ' + errs.join('、') + ' 有数据没写进去');
        else showToast('导入成功！' + done + ' 条记录已恢复，刷新各站即可看到');
      }, 600);
    };
    importOverlay.classList.add('show');
  }
  function closeImportDialog() { importOverlay.classList.remove('show'); }
  $('syncImportCancel').addEventListener('click', closeImportDialog);
  importOverlay.addEventListener('click', function (e) {
    if (e.target === importOverlay) closeImportDialog();
  });

  /* ================================================================
     清除：橙色小球，勾选清除哪个站
     ================================================================ */
  /* 清空指定库里的指定表（题库保留，只清数据表） */
  function clearStores(dbName, stores) {
    return new Promise(function (res) {
      var openReq;
      try { openReq = indexedDB.open(dbName); } catch (e) { res(); return; }
      openReq.onerror = function () { res(); };
      openReq.onblocked = function () { res(); };
      openReq.onsuccess = function () {
        var db = openReq.result;
        var jobs = [];
        stores.forEach(function (st) {
          if (!db.objectStoreNames.contains(st)) return;
          jobs.push(new Promise(function (ok) {
            try {
              var tx = db.transaction(st, 'readwrite');
              tx.objectStore(st).clear();
              tx.oncomplete = ok; tx.onerror = ok; tx.onabort = ok;
            } catch (e) { ok(); }
          }));
        });
        Promise.all(jobs).then(function () { try { db.close(); } catch (e) {} res(); },
          function () { try { db.close(); } catch (e) {} res(); });
      };
    });
  }

  function clearSiteData(s) {
    /* localStorage 按前缀删（排除名单里的跳过） */
    var keys = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k) continue;
        if (lsHit(k, s)) keys.push(k);
      }
    } catch (e) {}
    keys.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
    /* IndexedDB：有 dataStores 的站只清数据表（题库是内容，保留），否则整库删 */
    var jobs = (s.dbs || []).map(function (db) {
      if (s.dataStores && s.dataStores.length) return clearStores(db, s.dataStores);
      try { indexedDB.deleteDatabase(db); } catch (e) {}
      return Promise.resolve();
    });
    return Promise.all(jobs).then(function () { return keys.length; });
  }

  function openClearDialog() {
    closeDockInstant();
    var list = $('syncClearList');
    list.innerHTML = '';
    clearOverlay.classList.add('show');
    /* 有 IndexedDB 的站异步数一下记录，保证列表不漏 */
    var jobs = SITES.map(function (s) {
      return siteStats(s).then(function (st) { return { s: s, cnt: st.cnt, bytes: st.bytes }; });
    });
    Promise.all(jobs).then(function (rows) {
      var any = false;
      rows.forEach(function (r) {
        if (!r.cnt) return;
        any = true;
        var row = document.createElement('label');
        row.className = 'sync-site';
        row.innerHTML =
          '<input type="checkbox" data-site="' + r.s.id + '">' +
          '<span class="sync-tick"></span>' +
          '<span class="sync-site-txt"><b>' + r.s.name + '</b>' +
          '<i>' + r.cnt + ' 条记录 · ' + fmtSize(r.bytes) + '</i></span>';
        list.appendChild(row);
      });
      if (!any) {
        list.innerHTML = '<p style="margin-top:4px;font-size:12px;color:#8A92B4">' +
          '本机四个站都没有数据，没什么可清除的。</p>';
      }
      $('syncClearOk').disabled = !any;
    });
  }
  function closeClearDialog() { clearOverlay.classList.remove('show'); }
  orbClear.addEventListener('click', openClearDialog);
  $('syncClearCancel').addEventListener('click', closeClearDialog);
  clearOverlay.addEventListener('click', function (e) {
    if (e.target === clearOverlay) closeClearDialog();
  });
  /* 勾选状态同步到行的 .chk class（淡色底在老浏览器上的兜底，:has() 之外也有效） */
  [exportOverlay, clearOverlay].forEach(function (ov) {
    ov.addEventListener('change', function (e) {
      var row = e.target.closest ? e.target.closest('.sync-site') : null;
      if (row) row.classList.toggle('chk', e.target.checked);
    });
  });
  $('syncClearOk').addEventListener('click', function () {
    var picked = [];
    clearOverlay.querySelectorAll('input[data-site]').forEach(function (cb) {
      if (cb.checked) picked.push(cb.getAttribute('data-site'));
    });
    if (!picked.length) { showToast('先勾选要清除的站'); return; }
    var done = [];
    var jobs = [];
    picked.forEach(function (id) {
      var s = siteById(id);
      if (!s) return;
      jobs.push(clearSiteData(s));
      done.push(s.short);
    });
    closeClearDialog();
    showToast('正在清除 ' + done.join('、') + '…');
    Promise.all(jobs).then(function () {
      showToast('已清除 ' + done.join('、') + '，刷新各站后生效');
    }, function () {
      showToast('清除出错了，刷新页面再看');
    });
  });

  /* ================================================================
     矮窗口自适应（仅桌面）：100% 缩放下消掉垂直滚动条
     砍的顺序：页脚下方留白（完全不动页脚位置）→ 页脚上方空隙 →
     头部间距 → 古文行距 → 卡片行距 → 卡片内距。高屏一像素都不碰。
     ================================================================ */
  var fitTimer = null;
  function all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function resetFit() {
    var b = document.body;
    b.style.paddingTop = ''; b.style.paddingBottom = '';
    var ft = document.querySelector('footer');
    if (ft) ft.style.marginTop = '';
    var hd = document.querySelector('header');
    if (hd) hd.style.marginBottom = '';
    var bd = document.querySelector('.badge');
    if (bd) bd.style.marginBottom = '';
    var ld = document.querySelector('.lead');
    if (ld) { ld.style.marginTop = ''; ld.style.lineHeight = ''; }
    var gd = document.querySelector('.grid');
    if (gd) gd.style.rowGap = '';
    /* 卡片和描述必须整组清，只清第一张会留下残差，
       表现为放大网页再缩小后，下面两排卡片和上面两排不一样 */
    all('a.card').forEach(function (c) { c.style.paddingTop = ''; c.style.paddingBottom = ''; });
    all('.desc').forEach(function (d) { d.style.marginTop = ''; });
    var mt = document.querySelector('footer .motto');
    if (mt) mt.style.lineHeight = '';
    var h1 = document.querySelector('h1');
    if (h1) h1.style.fontSize = '';
  }
  function fitDesktop() {
    if (!window.matchMedia('(min-width:761px)').matches) { resetFit(); return; }
    resetFit();
    var de = document.documentElement;
    var b = document.body;
    var ft = document.querySelector('footer');
    var hd = document.querySelector('header');
    var bd = document.querySelector('.badge');
    var ld = document.querySelector('.lead');
    var gd = document.querySelector('.grid');
    var cd = document.querySelector('a.card');
    var ds = document.querySelector('.desc');
    var mt = document.querySelector('footer .motto');
    var h1 = document.querySelector('h1');
    function over() { return de.scrollHeight - de.clientHeight; }
    function num(el, prop) { return el ? (parseFloat(getComputedStyle(el)[prop]) || 0) : 0; }
    /* div = 这个杠杆每砍 1px 实际省几 px 行高（多行/多卡/双边距）。
       地板值按两套标准定：她常用的 1084x640 以上自然放下，一档都不会触发；
       下面的低地板只在极矮窗口（500px 上下）才够用，平时看不到。 */
    var levers = [
      { get: function () { return num(b, 'paddingBottom'); }, set: function (v) { b.style.paddingBottom = v + 'px'; }, floor: 4 },
      { get: function () { return num(ft, 'marginTop'); }, set: function (v) { ft.style.marginTop = v + 'px'; }, floor: 28 },
      { get: function () { return num(hd, 'marginBottom'); }, set: function (v) { hd.style.marginBottom = v + 'px'; }, floor: 13 },
      { get: function () { return num(b, 'paddingTop'); }, set: function (v) { b.style.paddingTop = v + 'px'; }, floor: 14 },
      { get: function () { return num(bd, 'marginBottom'); }, set: function (v) { bd.style.marginBottom = v + 'px'; }, floor: 9 },
      { get: function () { return num(ld, 'marginTop'); }, set: function (v) { ld.style.marginTop = v + 'px'; }, floor: 7 },
      { get: function () { return num(ld, 'lineHeight'); }, set: function (v) { ld.style.lineHeight = v + 'px'; }, floor: 21, div: 2 },
      { get: function () { return num(gd, 'rowGap'); }, set: function (v) { gd.style.rowGap = v + 'px'; }, floor: 6 },
      { get: function () { return num(cd, 'paddingTop'); }, set: function (v) { all('a.card').forEach(function (c) { c.style.paddingTop = v + 'px'; c.style.paddingBottom = v + 'px'; }); }, floor: 9, div: 4 },
      { get: function () { return num(ds, 'marginTop'); }, set: function (v) { all('.desc').forEach(function (d) { d.style.marginTop = v + 'px'; }); }, floor: 2, div: 4 },
      { get: function () { return num(h1, 'fontSize'); }, set: function (v) { h1.style.fontSize = v + 'px'; }, floor: 28 },
      { get: function () { return num(mt, 'lineHeight'); }, set: function (v) { mt.style.lineHeight = v + 'px'; }, floor: 15 }
    ];
    for (var i = 0; i < levers.length; i++) {
      if (over() <= 0) break;
      var lv = levers[i];
      var cur = lv.get();
      if (!cur) continue;
      var take = Math.min(cur - lv.floor, over() / (lv.div || 1));
      if (take > 0.5) lv.set(cur - take);
    }
  }
  window.__hubFit = fitDesktop;
  try { fitDesktop(); } catch (e) {}
  window.addEventListener('resize', function () {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(function () { try { fitDesktop(); } catch (e) {} }, 150);
  });

})();
