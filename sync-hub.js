/* ================================================================
   sync-hub.js · 主站数据同步（四站统一备份）
   ----------------------------------------------------------------
   四个子站同在 rosy0905.github.io 域名下，localStorage / IndexedDB
   天然共享，所以主站可以直接代读代写，不需要各站配合。

   存储分布：
   - 经济学  localStorage：eco_kb_* / 各模块前缀 / custom_* / ai_assistant_*
   - 阅读    localStorage：ekz*     IndexedDB：ekz-notes-v2（notes）
   - 单词    localStorage：dkz.*
   - 数学    localStorage：studyMath*   IndexedDB：study-math-v3（problems/status）

   导出格式：{ app:'study-hub-backup', version:1, exportedAt, sites:{...} }
   导入语义：备份里带的 key / 记录整块覆盖，本机有而备份没有的不动。
   AI 配置里的 API Key 导出时剔除，导入时保留本机已有的。
   ================================================================ */
(function () {
  'use strict';

  /* ---------- 站点定义 ---------- */
  var SITES = [
    {
      id: 'econ', name: '南开经济学·知识库', short: '经济学',
      lsPrefix: ['eco_kb_', 'micro_recite_', 'macro_recite_', 'calc_key_',
                 'calc_special_', 'micro_short_', 'macro_short_', 'essay_',
                 'past_exams_', 'custom_cards_', 'custom_chapters_',
                 'ai_assistant_'],
      dbs: []
    },
    {
      id: 'reading', name: '英语一·真题阅读', short: '英语阅读',
      lsPrefix: ['ekz'],
      dbs: ['ekz-notes-v2']
    },
    {
      id: 'words', name: '英语一·单词速刷', short: '单词速刷',
      lsPrefix: ['dkz.'],
      dbs: []
    },
    {
      id: 'math', name: '数学三·错题本', short: '数学三',
      lsPrefix: ['studyMath'],
      dbs: ['study-math-v3']
    }
  ];

  var AI_CFG_PREFIX = 'ai_assistant_cfg_';

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

  /* ---------- IndexedDB 读取：整库全量 ---------- */
  function idbDump(dbName) {
    return new Promise(function (res) {
      var openReq = indexedDB.open(dbName);
      openReq.onerror = function () { res({ __missing: true }); };
      openReq.onsuccess = function () {
        var db = openReq.result;
        var out = {};
        var names = Array.prototype.slice.call(db.objectStoreNames);
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
        var hit = site.lsPrefix.some(function (p) { return k.indexOf(p) === 0; });
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
  var fileInput = $('syncFile');
  var exportOverlay = $('syncExportOverlay');
  var importOverlay = $('syncImportOverlay');
  var toastEl = $('syncToast');

  var isOpen = false;

  function openDock() {
    isOpen = true;
    dock.classList.add('open');
    orbBtn.setAttribute('aria-expanded', 'true');
  }
  function closeDock() {
    isOpen = false;
    dock.classList.remove('open');
    orbBtn.setAttribute('aria-expanded', 'false');
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
      else if (isOpen) closeDock();
    }
  });

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
  function openExportDialog() {
    closeDock();
    var list = $('syncSiteList');
    list.innerHTML = '';
    SITES.forEach(function (s, idx) {
      var pack = collectSite(s);
      var cnt = countOf(pack);
      var row = document.createElement('label');
      row.className = 'sync-site' + (cnt ? '' : ' is-empty');
      row.innerHTML =
        '<input type="checkbox" data-site="' + s.id + '"' + (cnt ? ' checked' : ' disabled') + '>' +
        '<span class="sync-tick"></span>' +
        '<span class="sync-site-txt"><b>' + s.name + '</b>' +
        '<i>' + (cnt ? cnt + ' 条记录 · ' + fmtSize(bytesOf(pack)) : '本机暂无数据') + '</i></span>';
      list.appendChild(row);
    });
    refreshExportSize();
    exportOverlay.classList.add('show');
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
      if (s) total += bytesOf(collectSite(s));
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
          pack.indexedDB[s.dbs[j]] = await idbDump(s.dbs[j]);
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
    closeDock();
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

})();
