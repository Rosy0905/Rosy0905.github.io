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
      dbs: ['ekz-notes-v2', 'ekz-notes-db'],
      /* 下面这些不是学习记录，是阅读站自己写的运行时状态。
         每打开一篇文章，笔迹兜底备份（每个画布槽位一个数据键 + 一个时间戳键）、
         备份淘汰顺序表（ekz-ink-bk-lru）、自检面板日志、迁移标记都会新写几个键，
         复盘页还会给每篇添一个阅读位置。以前这些都算进"条数"，
         她导完 16 条、点开一篇回来就变成 24 条，看着像数据被复制了。
         计数和导出都跳过 lsNoRecord；lsExportSkip 是它的子集，
         画笔偏好（drawn.*）和阅读位置（ekz.pos.*）属于设置，
         仍然跟着备份走，换设备不用重设。 */
      lsNoRecord: ['ekz-ink-bk-', 'ekz-ink-bkts-', 'ekz-debug-log-v2', 'ekz-migrated',
                   'drawn.', 'ekz.pos.'],
      lsExportSkip: ['ekz-ink-bk-', 'ekz-ink-bkts-', 'ekz-debug-log-v2', 'ekz-migrated']
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

  /* 前缀命中判断的小工具 */
  function hitAny(k, list) {
    if (!list || !list.length) return false;
    for (var i = 0; i < list.length; i++) if (k.indexOf(list[i]) === 0) return true;
    return false;
  }

  /* 算不算"学习记录"（计数口径）：连运行时状态也不算 */
  function lsRecord(k, site) {
    if (!lsHit(k, site)) return false;
    return !hitAny(k, site.lsNoRecord);
  }

  /* 要不要写进备份（导出口径）：比计数宽一点，画笔偏好/阅读位置仍带上。
     兜底备份和日志是主库的副本或垃圾，带出去只会把备份文件撑大 */
  function lsExport(k, site) {
    if (!lsHit(k, site)) return false;
    return !hitAny(k, site.lsExportSkip);
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

  /* ---------- 探库：库到底存不存在 ----------
     【2026-10-25 修复】以前读数据直接 indexedDB.open(dbName) 不带版本号，
     库不存在时浏览器会「顺手」创建一个空壳（version 1、一张表都没有）。
     之后导入再打开这个空壳，onupgradeneeded 不触发，所有 store 都建不出来，
     数据被那句「建不出来的 store 跳过」静默吞掉——手机上 13 条笔记全丢、
     弹窗却还报「导入成功」，就是它干的。
     所以读写之前都必须先探一下库在不在，不在就一个字节都不写。 */
  function idbExists(dbName) {
    if (indexedDB.databases) {
      return new Promise(function (res) {
        var spent = false;
        var done = function (v) { if (spent) return; spent = true; clearTimeout(t); res(v); };
        /* databases() 迟迟不回来的话改用探库兜底，别把整轮统计吊死 */
        var t = setTimeout(function () {
          if (spent) return;
          probeByUpgrade(dbName).then(done, function () { done(false); });
        }, 600);
        try {
          indexedDB.databases().then(function (list) {
            done(list.some(function (d) { return d.name === dbName; }));
          }, function () {
            if (spent) return;
            probeByUpgrade(dbName).then(done, function () { done(false); });
          });
        } catch (e) {
          if (spent) return;
          probeByUpgrade(dbName).then(done, function () { done(false); });
        }
      });
    }
    return probeByUpgrade(dbName);
  }
  /* 老浏览器没有 databases() 时的兜底：一进 onupgradeneeded 就 abort，
     升级事务被中止，库就创建不出来，效果等同「只探不建」 */
  function probeByUpgrade(dbName) {
    return new Promise(function (res) {
      var spent = false;
      var done = function (v) { if (spent) return; spent = true; clearTimeout(t); res(v); };
      /* 探不动就当不存在：宁可不数，也绝不因为超时去开库（开库会造空壳） */
      var t = setTimeout(function () { done(false); }, 800);
      var r;
      try { r = indexedDB.open(dbName); } catch (e) { done(false); return; }
      r.onupgradeneeded = function () {
        try { r.transaction.abort(); } catch (e) {}
      };
      r.onsuccess = function () {
        try { r.result.close(); } catch (e) {}
        done(true);
      };
      r.onerror = function () { done(false); };
      r.onblocked = function () { done(true); };
    });
  }

  /* ---------- IndexedDB 读取：整库全量（onlyStores 给了就只读这些表） ---------- */
  function idbDump(dbName, onlyStores) {
    return idbExists(dbName).then(function (ok) {
      if (!ok) return { __missing: true };
      return dumpStores(dbName, onlyStores);
    });
  }
  function dumpStores(dbName, onlyStores) {
    return new Promise(function (res) {
      var spent = false;
      var finish = function (v) { if (spent) return; spent = true; clearTimeout(guard); res(v); };
      /* 库被别的标签页占着、升级卡住时 open 会一直不回调，这里也要有死线 */
      var guard = setTimeout(function () { finish({ __missing: true }); }, 1000);
      var openReq = indexedDB.open(dbName);
      /* 理论上探过一遍库一定在，这里再兜一层：万一读的瞬间库被别处删了，
         也绝不建空壳，直接报 missing */
      openReq.onupgradeneeded = function () {
        try { openReq.transaction.abort(); } catch (e) {}
      };
      openReq.onerror = function () { finish({ __missing: true }); };
      openReq.onblocked = function () { finish({ __missing: true }); };
      openReq.onsuccess = function () {
        var db = openReq.result;
        var out = {};
        var names = Array.prototype.slice.call(db.objectStoreNames);
        /* 有 dataStores 的站只读数据表：题库是随站内容，备份只带学习数据 */
        if (onlyStores && onlyStores.length) {
          names = names.filter(function (n) { return onlyStores.indexOf(n) >= 0; });
        }
        if (!names.length) { try { db.close(); } catch (e) {} finish(out); return; }
        var left = names.length;
        names.forEach(function (store) {
          var settle = function () { if (--left === 0) { try { db.close(); } catch (e) {} finish(out); } };
          try {
            var rq = db.transaction(store, 'readonly').objectStore(store).getAll();
            rq.onsuccess = function () { out[store] = rq.result || []; settle(); };
            rq.onerror = function () { out[store] = []; settle(); };
          } catch (e) {
            out[store] = []; settle();
          }
        });
      };
    });
  }

  /* ---------- IndexedDB 写入：按记录 put 覆盖 ---------- */
  /* 打开库并把缺的表补出来。
     ver 给了就按该版本升级建表；没给就按自然版本打开（库不存在时浏览器从 0 升 1，
     onupgradeneeded 照样触发，表能建出来）。 */
  function openForWrite(dbName, storeNames, ver) {
    return new Promise(function (res, rej) {
      var openReq = ver ? indexedDB.open(dbName, ver) : indexedDB.open(dbName);
      openReq.onupgradeneeded = function () {
        var db = openReq.result;
        storeNames.forEach(function (s) {
          if (!db.objectStoreNames.contains(s)) {
            try { db.createObjectStore(s, { keyPath: 'id' }); } catch (e) {}
          }
        });
      };
      openReq.onsuccess = function () { res(openReq.result); };
      openReq.onerror = function () { rej(openReq.error || new Error('打不开数据库 ' + dbName)); };
      /* 别处还开着旧版本连接时升级会被卡住，如实报错，不装死 */
      openReq.onblocked = function () { rej(new Error('数据库被其他标签页占用，关掉其他页面再试')); };
    });
  }

  /* 往已打开的表里整批 put，返回缺表清单 */
  function writeStores(db, data) {
    var names = Array.prototype.slice.call(db.objectStoreNames);
    var jobs = [];
    var skipped = [];
    Object.keys(data).forEach(function (store) {
      var rows = data[store];
      if (!Array.isArray(rows)) return;
      if (names.indexOf(store) < 0) { if (rows.length) skipped.push(store); return; }
      if (!rows.length) return;
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
    return Promise.all(jobs.map(function (p) {
      return p.then(function () { return null; }, function (e) { return e; });
    })).then(function (errs) {
      var bad = errs.filter(Boolean);
      if (bad.length) throw bad[0];
      /* 补不齐的表必须报出来，否则又变成静默丢数据 */
      if (skipped.length) throw new Error('缺少数据表 ' + skipped.join('、'));
    });
  }

  function idbRestore(dbName, data) {
    /* 备份里真有数据的表才算「需要」 */
    var want = Object.keys(data).filter(function (k) {
      return Array.isArray(data[k]) && data[k].length;
    });
    return idbExists(dbName).then(function (ok) {
      if (!ok) return openForWrite(dbName, want, null);
      return openForWrite(dbName, [], null).then(function (db) {
        var missing = want.filter(function (s) { return !db.objectStoreNames.contains(s); });
        if (!missing.length) return db;
        /* 库在但缺表（统计体检造出来的空壳就是这种）→ 升一版把表补齐再写 */
        var nextVer = db.version + 1;
        try { db.close(); } catch (e) {}
        return openForWrite(dbName, missing, nextVer);
      });
    }).then(function (db) {
      var total = 0;
      Object.keys(data).forEach(function (st) {
        if (Array.isArray(data[st])) total += data[st].length;
      });
      return writeStores(db, data).then(function () {
        try { db.close(); } catch (e) {}
        return total; /* 报告真写进去的条数，不再由调用方乐观估算 */
      }, function (e) {
        try { db.close(); } catch (_) {}
        throw e;
      });
    });
  }

  /* ---------- 收集本机数据 ---------- */
  /* mode='count'（默认）按"学习记录"口径收集，运行时状态不进；
     mode='export' 宽一档，画笔偏好和阅读位置会带上。
     清除不走这里，清除按 lsHit 全删，缓存也得删干净，
     否则清完再打开文章，笔迹兜底备份会把笔迹灌回来。 */
  function collectLs(site, mode) {
    var test = mode === 'export' ? lsExport : lsRecord;
    var out = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k) continue;
        if (!test(k, site)) continue;
        var v = localStorage.getItem(k);
        if (typeof v === 'string') out[k] = v;
      }
    } catch (e) {}
    return out;
  }

  function collectSite(site, mode) {
    var pack = { localStorage: collectLs(site, mode) };
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
  var clearConfirmOverlay = $('syncClearConfirmOverlay');
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
  function siteStats(s) {
    var pack = collectSite(s);
    var cnt = countOf(pack);
    var bytes = bytesOf(pack);
    if (!s.dbs.length) return Promise.resolve({ cnt: cnt, bytes: bytes });
    return Promise.all(s.dbs.map(function (d) { return idbDump(d, s.dataStores); }))
      .then(function (dumps) {
        dumps.forEach(function (data) {
          if (!data || data.__missing) return;
          Object.keys(data).forEach(function (st) {
            if (Array.isArray(data[st])) { cnt += data[st].length; bytes += utf8Len(JSON.stringify(data[st])); }
          });
        });
        return { cnt: cnt, bytes: bytes };
      });
  }

  /* 统计预缓存：进页面就后台把四站数好存着。弹窗打开时直接用缓存同步渲染，
     不再先弹出标题和说明、勾选框等 IndexDB 读完才补上——那种两级出场
     她自己看出不对劲了。换标签页回来 / 自己刚清完 / 刚导入完都会重数，
     超过 3 秒的缓存也当过期，打开前现数一次，保证不拿旧数据骗人。 */
  var statsFull = {};
  var statsAt = 0;
  /* 单站统计绝不无限等：某个库被别的标签页占着、浏览器迟迟不给回调，
     到点就用手上的缓存（没有就给空值）交差，不让整轮统计跟着卡死 */
  var STATS_WAIT = 1200;
  function statsSafe(s) {
    return new Promise(function (res) {
      var spent = false;
      var t = setTimeout(function () {
        if (spent) return; spent = true;
        var old = statsFull[s.id];
        res(old ? { cnt: old.cnt, bytes: old.bytes, __stale: true } : { cnt: 0, bytes: 0, __fail: true });
      }, STATS_WAIT);
      var done = function (st) {
        if (spent) return; spent = true;
        clearTimeout(t);
        res(st || (statsFull[s.id] ? statsFull[s.id] : { cnt: 0, bytes: 0, __fail: true }));
      };
      try { siteStats(s).then(done, function () { done(null); }); }
      catch (e) { done(null); }
    });
  }
  function refreshAllStats() {
    return Promise.all(SITES.map(function (s) {
      return statsSafe(s).then(function (st) {
        /* 真读到的（哪怕读出来是 0 条）才进缓存，超时兜底的占位不覆盖真值 */
        if (st && !st.__fail) statsFull[s.id] = { cnt: st.cnt, bytes: st.bytes };
      });
    })).then(function () { statsAt = Date.now(); }, function () { statsAt = Date.now(); });
  }
  function statsOf(id) { return statsFull[id] || { cnt: 0, bytes: 0 }; }
  function statsFresh() { return Date.now() - statsAt < 3000; }
  /* 打开弹窗的统一入口：缓存新鲜就同步渲染，否则现数再开，两种走法
     弹窗都是一次性完整出现，没有中间态。此外还有一道死线：球已经收起去了，
     要是一直等不到统计，面板就永远不出现——所以无论如何到点都把面板放出来。 */
  var PANEL_DEADLINE = 1400;
  function withStats(show) {
    var ready = SITES.every(function (s) { return statsFull[s.id]; });
    if (ready && statsFresh()) { show(); return; }
    var fired = false;
    var fire = function () { if (fired) return; fired = true; show(); };
    refreshAllStats().then(fire, fire);
    setTimeout(fire, PANEL_DEADLINE);
  }
  refreshAllStats();
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshAllStats();
  });
  window.addEventListener('focus', refreshAllStats);

  function openExportDialog() {
    closeDockInstant();
    withStats(function () {
      /* 渲染万一出错也要把面板放出来：球已经收起来了，
         面板不出来就变成"点了没反应"，只能刷新页面才能恢复 */
      try {
        var list = $('syncSiteList');
        list.innerHTML = '';
        SITES.forEach(function (s) {
          var st = statsOf(s.id);
          var row = document.createElement('label');
          row.className = 'sync-site' + (st.cnt ? ' chk' : ' is-empty');
          row.innerHTML =
            '<input type="checkbox" data-site="' + s.id + '"' + (st.cnt ? ' checked' : ' disabled') + '>' +
            '<span class="sync-tick"></span>' +
            '<span class="sync-site-txt"><b>' + s.name + '</b>' +
            '<i>' + (st.cnt ? st.cnt + ' 条记录 · ' + fmtSize(st.bytes) : '本机暂无数据') + '</i></span>';
          list.appendChild(row);
        });
        refreshExportSize();
      } catch (e) {}
      exportOverlay.classList.add('show');
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
      total += statsOf(id).bytes;
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
      var pack = collectSite(s, 'export');
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
        /* 预览按"学习记录"口径数，跟导入后主站显示的数字对齐。
           老备份里可能夹着笔迹兜底备份、日志这类运行时状态，
           要是照原样数，预览说 24 条、导完显示 16 条，又对不上了。
           实际写入不受影响，文件里有的键照样落盘。 */
        var lsOk = {};
        Object.keys(it.pack.localStorage || {}).forEach(function (k) {
          if (lsRecord(k, it.site)) lsOk[k] = 1;
        });
        var cnt = countOf({ localStorage: lsOk, indexedDB: it.pack.indexedDB });
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
      var idbJobs = [];
      found.forEach(function (it) {
        var s = it.site, pack = it.pack;
        /* localStorage：同步写，写完就能算数 */
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
        /* IndexedDB：异步，全部收进 idbJobs。
           【2026-10-25 修复】以前固定 setTimeout 600ms 就报「导入成功」，
           那会儿大记录可能还没落盘，手机上看到成功就切走，数据就没了。
           现在等每一条真写完（或真失败）才报，失败会把原因说出来。 */
        var dbs = pack.indexedDB || {};
        Object.keys(dbs).forEach(function (dbName) {
          var data = dbs[dbName];
          if (!data || data.__missing) return;
          idbJobs.push(idbRestore(dbName, data).then(function (n) {
            done += n;
          }, function (e) {
            var why = (e && e.message) ? e.message : '写入失败';
            errs.push(s.short + '（' + dbName + '：' + why + '）');
          }));
        });
      });
      Promise.all(idbJobs).then(function () {
        if (errs.length) showToast('导入完成，但 ' + errs.join('、') + ' 有数据没写进去');
        else showToast('导入成功！' + done + ' 条记录已恢复，刷新各站即可看到');
        refreshAllStats();
      });
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
    /* 同上：库不存在就直接收工，绝不顺手造空壳 */
    return idbExists(dbName).then(function (ok) {
      if (!ok) return;
      return new Promise(function (res) {
        var openReq;
        try { openReq = indexedDB.open(dbName); } catch (e) { res(); return; }
        openReq.onupgradeneeded = function () {
          try { openReq.transaction.abort(); } catch (e) {}
        };
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

  /* 清除弹窗当前各站的统计，二次确认弹层照着列清单 */
  var clearRows = [];
  function openClearDialog() {
    closeDockInstant();
    withStats(function () {
      try {
        var list = $('syncClearList');
        list.innerHTML = '';
        clearRows = SITES.map(function (s) {
          var st = statsOf(s.id);
          return { s: s, cnt: st.cnt, bytes: st.bytes };
        });
        var any = false;
        clearRows.forEach(function (r) {
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
        refreshClearSize();
      } catch (e) {}
      clearOverlay.classList.add('show');
    });
  }
  /* 总量行：和导出弹窗的"预计文件大小"对称，勾选时实时算 */
  function refreshClearSize() {
    var el = $('syncClearSize');
    if (!el) return;
    var cnt = 0, bytes = 0, n = 0;
    clearOverlay.querySelectorAll('input[data-site]').forEach(function (cb) {
      if (!cb.checked) return;
      n++;
      for (var i = 0; i < clearRows.length; i++) {
        if (clearRows[i].s.id === cb.getAttribute('data-site')) {
          cnt += clearRows[i].cnt; bytes += clearRows[i].bytes; break;
        }
      }
    });
    el.innerHTML = n
      ? '将清除 <b>' + cnt + '</b> 条记录 · 约 ' + fmtSize(bytes)
      : '勾选站点后，这里显示将清除的总量';
  }
  function closeClearDialog() { clearOverlay.classList.remove('show'); }
  orbClear.addEventListener('click', openClearDialog);
  $('syncClearCancel').addEventListener('click', closeClearDialog);
  clearOverlay.addEventListener('click', function (e) {
    if (e.target === clearOverlay) closeClearDialog();
  });
  /* 勾选状态同步到行的 .chk class（淡色底在老浏览器上的兜底，:has() 之外也有效）；
     清除弹窗里还要顺带刷新总量行 */
  [exportOverlay, clearOverlay].forEach(function (ov) {
    ov.addEventListener('change', function (e) {
      var row = e.target.closest ? e.target.closest('.sync-site') : null;
      if (row) row.classList.toggle('chk', e.target.checked);
      if (ov === clearOverlay) refreshClearSize();
    });
  });
  /* 点「清除」不直接删，先过二次确认这道闸 */
  $('syncClearOk').addEventListener('click', function () {
    var picked = pickedSiteIds();
    if (!picked.length) { showToast('先勾选要清除的站'); return; }
    openClearConfirm(picked);
  });
  function pickedSiteIds() {
    var picked = [];
    clearOverlay.querySelectorAll('input[data-site]').forEach(function (cb) {
      if (cb.checked) picked.push(cb.getAttribute('data-site'));
    });
    return picked;
  }
  function openClearConfirm(picked) {
    var list = $('syncClearConfirmList');
    list.innerHTML = '';
    picked.forEach(function (id) {
      var row = null;
      for (var i = 0; i < clearRows.length; i++) {
        if (clearRows[i].s.id === id) { row = clearRows[i]; break; }
      }
      if (!row) return;
      var el = document.createElement('div');
      el.className = 'sync-import-row';
      el.innerHTML = '<b>' + row.s.name + '</b><i>' + row.cnt + ' 条记录</i>';
      list.appendChild(el);
    });
    clearConfirmOverlay.classList.add('show');
  }
  function closeClearConfirm() { clearConfirmOverlay.classList.remove('show'); }
  $('syncClearConfirmCancel').addEventListener('click', closeClearConfirm);
  clearConfirmOverlay.addEventListener('click', function (e) {
    if (e.target === clearConfirmOverlay) closeClearConfirm();
  });
  /* 确认清除：这里才真删 */
  $('syncClearConfirmOk').addEventListener('click', function () {
    var picked = pickedSiteIds();
    if (!picked.length) { closeClearConfirm(); return; }
    closeClearConfirm();
    closeClearDialog();
    var done = [];
    var jobs = [];
    picked.forEach(function (id) {
      var s = siteById(id);
      if (!s) return;
      jobs.push(clearSiteData(s));
      done.push(s.short);
    });
    showToast('正在清除 ' + done.join('、') + '…');
    Promise.all(jobs).then(function () {
      showToast('已清除 ' + done.join('、') + '，刷新各站后生效');
      refreshAllStats();
    }, function () {
      showToast('清除出错了，刷新页面再看');
    });
  });

})();
