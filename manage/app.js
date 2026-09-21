/* 澤日影像 照片管理
   直接讀寫 GitHub repo(data/photos.json + photos/<分類>/<id>.jpg)。
   所有修改先暫存在頁面上,按「發佈到網站」才會合併成一個 commit 推上去。 */
(function () {
  'use strict';

  var REPO = 'dannie3104/zerihstudio';
  var BRANCH = 'main';
  var NETLIFY_API = 'https://api.netlify.com';
  var SITE_ID = 'elegant-fenglisu-a79e7c.netlify.app';
  var TOKEN_KEY = 'zerih_gh_token';
  var RAW_BASE = 'https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/';
  var MAX_DIM = 1600;
  var QUALITY = 0.82;

  var token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch (e) {}

  var state = {
    user: null,
    cats: [],
    photos: [],
    deleted: [],          /* [{id, file}] 已存在於 repo、準備刪除的照片 */
    origById: {},         /* id -> 載入時的 JSON 字串,用來計算「修改」數量 */
    photosSha: '',
    headSha: '',
    view: { cat: '', tag: '*' },
    selected: {},         /* id -> true */
    previews: {},         /* file -> blob URL(剛上傳、網站上還看不到的照片) */
    busy: false
  };

  /* ---------------------------------------------------------------- utils */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function b64ToUtf8(b64) {
    var bin = atob(String(b64).replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1]); };
      r.onerror = function () { reject(new Error('讀取照片失敗')); };
      r.readAsDataURL(blob);
    });
  }
  function newId() {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var id;
    do {
      id = '';
      for (var i = 0; i < 20; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
    } while (state.photos.some(function (p) { return p.id === id; }));
    return id;
  }
  var toastTimer;
  function toast(msg, isError) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, isError ? 7000 : 3500);
  }

  /* ------------------------------------------------------------ GitHub API */
  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Accept': 'application/vnd.github+json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch('https://api.github.com' + path, {
      method: opts.method || 'GET',
      headers: headers,
      cache: 'no-store',
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      if (r.status === 401) {
        token = null;
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
        throw new Error('登入已過期,請重新整理頁面後再登入一次');
      }
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          var e = new Error('GitHub 回應錯誤(' + r.status + ')' + (j.message ? ':' + j.message : ''));
          e.status = r.status;
          throw e;
        });
      }
      return r.status === 204 ? null : r.json();
    });
  }
  function readJsonFile(path) {
    return api('/repos/' + REPO + '/contents/' + path + '?ref=' + BRANCH).then(function (r) {
      return { sha: r.sha, data: JSON.parse(b64ToUtf8(r.content)) };
    });
  }
  function getHeadSha() {
    return api('/repos/' + REPO + '/git/ref/heads/' + BRANCH).then(function (r) { return r.object.sha; });
  }

  /* -------------------------------------------------------- Netlify 登入 */
  function netlifyLogin() {
    return new Promise(function (resolve, reject) {
      var authWin;
      function handshake(e) {
        if (e.origin !== NETLIFY_API || e.data !== 'authorizing:github') return;
        window.removeEventListener('message', handshake);
        window.addEventListener('message', authorize);
        authWin.postMessage(e.data, e.origin);
      }
      function authorize(e) {
        if (e.origin !== NETLIFY_API || typeof e.data !== 'string') return;
        var ok = 'authorization:github:success:';
        var bad = 'authorization:github:error:';
        if (e.data.indexOf(ok) === 0) {
          window.removeEventListener('message', authorize);
          authWin.close();
          try { resolve(JSON.parse(e.data.slice(ok.length))); } catch (err) { reject(err); }
        } else if (e.data.indexOf(bad) === 0) {
          window.removeEventListener('message', authorize);
          authWin.close();
          reject(new Error('GitHub 授權失敗'));
        }
      }
      window.addEventListener('message', handshake);
      var w = 960, h = 600;
      authWin = window.open(
        NETLIFY_API + '/auth?provider=github&site_id=' + SITE_ID + '&scope=repo',
        'Netlify Authorization',
        'width=' + w + ',height=' + h + ',top=' + Math.round(screen.height / 2 - h / 2) + ',left=' + Math.round(screen.width / 2 - w / 2)
      );
      if (!authWin) {
        window.removeEventListener('message', handshake);
        reject(new Error('瀏覽器擋住了彈出視窗,請允許這個網站的彈出視窗後再按一次登入'));
      }
    });
  }

  /* --------------------------------------------------------------- 資料 */
  /* 存進 photos.json 的樣子:去掉暫存欄位(_開頭),保留其他未知欄位 */
  function clean(p) {
    var o = {
      id: p.id, category: p.category, tag: p.tag || '', order: p.order,
      file: p.file, isCover: !!p.isCover, isFeatured: !!p.isFeatured
    };
    Object.keys(p).forEach(function (k) {
      if (k.charAt(0) !== '_' && !(k in o) && k !== 'coverPos') o[k] = p[k];
    });
    if (p.isCover && p.coverPos != null) o.coverPos = p.coverPos;
    return o;
  }
  function catIndex(id) {
    for (var i = 0; i < state.cats.length; i++) if (state.cats[i].id === id) return i;
    return 999;
  }
  function loadAll() {
    return Promise.all([
      readJsonFile('data/photos.json'),
      readJsonFile('data/categories.json'),
      getHeadSha()
    ]).then(function (res) {
      state.photosSha = res[0].sha;
      state.photos = (res[0].data.photos || []).map(function (p) { return Object.assign({}, p); });
      state.cats = (res[1].data.categories || []).slice().sort(function (a, b) { return a.order - b.order; });
      state.headSha = res[2];
      state.deleted = [];
      state.selected = {};
      state.origById = {};
      state.photos.forEach(function (p) { state.origById[p.id] = JSON.stringify(clean(p)); });
      if (state.view.cat && !state.cats.some(function (c) { return c.id === state.view.cat; })) state.view.cat = '';
    });
  }
  function changeCounts() {
    var added = 0, modified = 0;
    state.photos.forEach(function (p) {
      if (p._blob) added++;
      else if (state.origById[p.id] !== JSON.stringify(clean(p))) modified++;
    });
    return { added: added, removed: state.deleted.length, modified: modified };
  }
  function isDirty() {
    var c = changeCounts();
    return !!(c.added || c.removed || c.modified);
  }

  /* --------------------------------------------------------------- 上傳 */
  function readExifOrientation(file) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function (e) {
        try {
          var view = new DataView(e.target.result);
          if (view.getUint16(0, false) !== 0xFFD8) { resolve(1); return; }
          var length = view.byteLength, offset = 2;
          while (offset < length) {
            var marker = view.getUint16(offset, false);
            offset += 2;
            if (marker === 0xFFE1) {
              if (view.getUint32(offset += 2, false) !== 0x45786966) { resolve(1); return; }
              var little = view.getUint16(offset += 6, false) === 0x4949;
              offset += view.getUint32(offset + 4, little);
              var tags = view.getUint16(offset, little);
              offset += 2;
              for (var i = 0; i < tags; i++) {
                if (view.getUint16(offset + (i * 12), little) === 0x0112) {
                  resolve(view.getUint16(offset + (i * 12) + 8, little));
                  return;
                }
              }
              resolve(1); return;
            } else if ((marker & 0xFF00) !== 0xFF00) {
              break;
            } else {
              offset += view.getUint16(offset, false);
            }
          }
        } catch (err) {}
        resolve(1);
      };
      reader.onerror = function () { resolve(1); };
      reader.readAsArrayBuffer(file.slice(0, 128 * 1024));
    });
  }
  function applyOrientationTransform(ctx, orientation, w, h) {
    switch (orientation) {
      case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
      case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
      case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
      case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
      case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
      case 7: ctx.transform(0, -1, -1, 0, h, w); break;
      case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
      default: break;
    }
  }
  /* 縮成長邊 MAX_DIM 的 JPEG,並修正手機拍照的方向;失敗回傳 null */
  function resizeToJpeg(file) {
    return readExifOrientation(file).then(function (orientation) {
      return new Promise(function (resolve) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          URL.revokeObjectURL(url);
          var w = img.naturalWidth, h = img.naturalHeight;
          var scale = Math.min(1, MAX_DIM / Math.max(w, h));
          var dw = Math.round(w * scale), dh = Math.round(h * scale);
          var swap = orientation >= 5 && orientation <= 8;
          var canvas = document.createElement('canvas');
          canvas.width = swap ? dh : dw;
          canvas.height = swap ? dw : dh;
          var ctx = canvas.getContext('2d');
          applyOrientationTransform(ctx, orientation, dw, dh);
          ctx.drawImage(img, 0, 0, dw, dh);
          canvas.toBlob(function (blob) { resolve(blob || null); }, 'image/jpeg', QUALITY);
        };
        img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;
      });
    });
  }
  function nextOrder(cat) {
    var max = 0;
    state.photos.forEach(function (p) { if (p.category === cat && p.order > max) max = p.order; });
    return max + 1;
  }
  async function handleFiles(fileList) {
    if (state.busy) return;
    if (!state.view.cat) { toast('請先在上方選一個分類,再上傳照片', true); return; }
    var files = Array.prototype.slice.call(fileList).filter(function (f) {
      return /^image\//.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name);
    });
    if (!files.length) { toast('沒有找到可以上傳的圖片(支援 JPG / PNG / WebP)', true); return; }
    var cat = state.view.cat, failed = 0;
    state.busy = true;
    for (var i = 0; i < files.length; i++) {
      setStatus('處理照片中… ' + (i + 1) + ' / ' + files.length);
      var blob = await resizeToJpeg(files[i]);
      if (!blob) { failed++; continue; }
      var id = newId();
      var file = 'photos/' + cat + '/' + id + '.jpg';
      state.previews[file] = URL.createObjectURL(blob);
      state.photos.push({
        id: id, category: cat, tag: '', order: nextOrder(cat), file: file,
        isCover: false, isFeatured: false, _blob: blob
      });
    }
    state.busy = false;
    setStatus('');
    render();
    toast('已加入 ' + (files.length - failed) + ' 張照片' + (failed ? ',' + failed + ' 張無法處理(可能是 HEIC 格式)' : '') + '。記得按下方「發佈到網站」才會生效', failed > 0);
  }

  /* --------------------------------------------------------------- 發佈 */
  async function publish() {
    if (state.busy || !isDirty()) return;
    var counts = changeCounts();
    var summary = [];
    if (counts.added) summary.push('新增 ' + counts.added + ' 張');
    if (counts.removed) summary.push('刪除 ' + counts.removed + ' 張');
    if (counts.modified) summary.push('修改 ' + counts.modified + ' 張');
    if (!confirm('要發佈這些變更到網站嗎?\n' + summary.join('、') + '\n\n發佈後網站約 1–2 分鐘會更新。')) return;
    state.busy = true;
    render();
    try {
      setStatus('確認資料是否最新…');
      var latest = await getHeadSha();
      if (latest !== state.headSha) {
        var cur = await api('/repos/' + REPO + '/contents/data/photos.json?ref=' + BRANCH);
        if (cur.sha !== state.photosSha) {
          throw new Error('在你編輯的期間,照片資料已經被別人更新過了。為避免覆蓋,請重新整理頁面後再修改一次。');
        }
      }
      var baseCommit = await api('/repos/' + REPO + '/git/commits/' + latest);
      var tree = [];
      var newPhotos = state.photos.filter(function (p) { return p._blob; });
      for (var i = 0; i < newPhotos.length; i++) {
        setStatus('上傳照片 ' + (i + 1) + ' / ' + newPhotos.length + '…');
        var b64 = await blobToBase64(newPhotos[i]._blob);
        var blob = await api('/repos/' + REPO + '/git/blobs', { method: 'POST', body: { content: b64, encoding: 'base64' } });
        tree.push({ path: newPhotos[i].file, mode: '100644', type: 'blob', sha: blob.sha });
      }
      state.deleted.forEach(function (d) {
        tree.push({ path: d.file, mode: '100644', type: 'blob', sha: null });
      });
      var json = JSON.stringify({ photos: state.photos.map(clean) }, null, 2) + '\n';
      tree.push({ path: 'data/photos.json', mode: '100644', type: 'blob', content: json });
      setStatus('建立提交…');
      var newTree = await api('/repos/' + REPO + '/git/trees', { method: 'POST', body: { base_tree: baseCommit.tree.sha, tree: tree } });
      var commit = await api('/repos/' + REPO + '/git/commits', {
        method: 'POST',
        body: { message: '更新照片(' + summary.join('、') + ')', tree: newTree.sha, parents: [latest] }
      });
      setStatus('發佈中…');
      await api('/repos/' + REPO + '/git/refs/heads/' + BRANCH, { method: 'PATCH', body: { sha: commit.sha } });
      await loadAll();
      state.busy = false;
      setStatus('');
      render();
      toast('已發佈!網站約 1–2 分鐘後會更新。');
    } catch (err) {
      state.busy = false;
      setStatus('');
      render();
      toast('發佈失敗:' + err.message, true);
    }
  }

  /* ------------------------------------------------------------- 篩選 */
  function tagsOf(cat) {
    var seen = {}, list = [];
    state.photos.forEach(function (p) {
      if ((!cat || p.category === cat) && p.tag && !seen[p.tag]) { seen[p.tag] = true; list.push(p.tag); }
    });
    return list;
  }
  function visiblePhotos() {
    var v = state.view;
    var list = state.photos.map(function (p, i) { return { p: p, i: i }; }).filter(function (x) {
      var p = x.p;
      if (v.cat && p.category !== v.cat) return false;
      if (v.tag === '__feat') return !!p.isFeatured;
      if (v.tag === '__none') return !p.tag;
      if (v.tag !== '*') return p.tag === v.tag;
      return true;
    });
    list.sort(function (a, b) {
      return (catIndex(a.p.category) - catIndex(b.p.category)) || (a.p.order - b.p.order) || (a.i - b.i);
    });
    return list.map(function (x) { return x.p; });
  }
  function canReorder() { return !!state.view.cat && state.view.tag === '*'; }
  function catPhotosSorted(cat) {
    var list = state.photos.map(function (p, i) { return { p: p, i: i }; }).filter(function (x) { return x.p.category === cat; });
    list.sort(function (a, b) { return (a.p.order - b.p.order) || (a.i - b.i); });
    return list.map(function (x) { return x.p; });
  }
  function moveTo(id, targetId) {
    var cat = state.view.cat;
    var list = catPhotosSorted(cat);
    var from = -1, to = -1;
    list.forEach(function (p, i) { if (p.id === id) from = i; if (p.id === targetId) to = i; });
    if (from < 0 || to < 0 || from === to) return;
    var item = list.splice(from, 1)[0];
    list.splice(to, 0, item);
    list.forEach(function (p, i) { p.order = i + 1; });
    render();
  }
  function moveBy(id, delta) {
    var list = catPhotosSorted(state.view.cat);
    var idx = -1;
    list.forEach(function (p, i) { if (p.id === id) idx = i; });
    var t = idx + delta;
    if (idx < 0 || t < 0 || t >= list.length) return;
    moveTo(id, list[t].id);
  }
  function findPhoto(id) {
    for (var i = 0; i < state.photos.length; i++) if (state.photos[i].id === id) return state.photos[i];
    return null;
  }
  function removePhotos(ids) {
    ids.forEach(function (id) {
      var p = findPhoto(id);
      if (!p) return;
      if (state.origById[id] && !p._blob) state.deleted.push({ id: id, file: p.file });
      if (state.previews[p.file]) { URL.revokeObjectURL(state.previews[p.file]); delete state.previews[p.file]; }
      state.photos.splice(state.photos.indexOf(p), 1);
      delete state.selected[id];
    });
    render();
  }

  /* --------------------------------------------------------------- 畫面 */
  function setStatus(msg) {
    var s = $('#status');
    if (s) s.textContent = msg;
  }
  function imgSrc(p) { return state.previews[p.file] || (RAW_BASE + p.file); }
  function cardHtml(p, reorder) {
    var pos = p.coverPos != null ? p.coverPos : 50;
    var isNew = !!p._blob;
    return '<div class="card' + (p.isCover ? ' is-cover' : '') + (p.isFeatured ? ' is-feat' : '') + (isNew ? ' is-new' : '') + (state.selected[p.id] ? ' is-sel' : '') + '" data-id="' + esc(p.id) + '"' + (reorder ? ' draggable="true"' : '') + '>' +
      '<div class="thumb">' +
        '<img loading="lazy" decoding="async" draggable="false" alt="" src="' + esc(imgSrc(p)) + '" style="object-position:50% ' + (p.isCover ? pos : 50) + '%">' +
        '<label class="selbox" title="選取"><input type="checkbox" class="sel"' + (state.selected[p.id] ? ' checked' : '') + '></label>' +
        '<span class="badges"><b class="bd bd-new">新</b><b class="bd bd-cover">封面</b><b class="bd bd-feat">精選</b></span>' +
      '</div>' +
      '<div class="body">' +
        '<input type="text" class="tag" list="taglist" maxlength="30" placeholder="風格標籤(可留空)" value="' + esc(p.tag) + '">' +
        '<div class="row2">' +
          '<label class="chk"><input type="checkbox" class="feat"' + (p.isFeatured ? ' checked' : '') + '> 精選</label>' +
          '<label class="chk"><input type="checkbox" class="cover"' + (p.isCover ? ' checked' : '') + '> 分類封面</label>' +
        '</div>' +
        '<div class="pos"' + (p.isCover ? '' : ' hidden') + '>' +
          '<span>封面位置</span><input type="range" class="cpos" min="0" max="100" step="5" value="' + pos + '"><span class="posv">' + pos + '%</span>' +
        '</div>' +
        '<div class="row2 acts">' +
          (reorder ? '<button type="button" class="btn sm mv-l" title="往前移">←</button><button type="button" class="btn sm mv-r" title="往後移">→</button>' : '<span></span>') +
          '<button type="button" class="btn sm danger del">刪除</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }
  function syncCard(el, p) {
    el.classList.toggle('is-cover', !!p.isCover);
    el.classList.toggle('is-feat', !!p.isFeatured);
    el.classList.toggle('is-new', !!p._blob);
    el.classList.toggle('is-sel', !!state.selected[p.id]);
    $('.feat', el).checked = !!p.isFeatured;
    $('.cover', el).checked = !!p.isCover;
    $('.sel', el).checked = !!state.selected[p.id];
    var pos = p.coverPos != null ? p.coverPos : 50;
    $('.pos', el).hidden = !p.isCover;
    $('.cpos', el).value = pos;
    $('.posv', el).textContent = pos + '%';
    $('img', el).style.objectPosition = '50% ' + (p.isCover ? pos : 50) + '%';
  }
  function renderBar() {
    var c = changeCounts();
    var parts = [];
    if (c.added) parts.push('新增 ' + c.added);
    if (c.removed) parts.push('刪除 ' + c.removed);
    if (c.modified) parts.push('修改 ' + c.modified);
    var dirty = parts.length > 0;
    $('#barText').textContent = dirty ? '尚未發佈的變更:' + parts.join(' · ') + ' 張' : '目前沒有未發佈的變更';
    $('#publishBtn').disabled = !dirty || state.busy;
    $('#discardBtn').disabled = !dirty || state.busy;
    $('#bar').classList.toggle('dirty', dirty);
  }
  function renderBulk() {
    var n = Object.keys(state.selected).length;
    $('#bulk').hidden = n === 0;
    $('#bulkCount').textContent = '已選取 ' + n + ' 張';
  }
  /* 標籤篩選下拉與輸入建議;輸入標籤時只更新這裡,不重繪整個照片格(避免吃掉使用者接著的點擊) */
  function refreshTagLists() {
    var tagOpts = '<option value="*">全部標籤</option><option value="__feat">只看精選</option><option value="__none">只看未分類(沒有標籤)</option>';
    var tags = tagsOf(state.view.cat);
    tags.forEach(function (t) { tagOpts += '<option value="' + esc(t) + '">' + esc(t) + '</option>'; });
    var sel = $('#tagFilter');
    sel.innerHTML = tagOpts;
    if (state.view.tag !== '*' && state.view.tag !== '__feat' && state.view.tag !== '__none' && tags.indexOf(state.view.tag) < 0) state.view.tag = '*';
    sel.value = state.view.tag;
    $('#taglist').innerHTML = tags.map(function (t) { return '<option value="' + esc(t) + '">'; }).join('');
  }
  function render() {
    /* 分類頁籤 */
    var counts = {};
    state.photos.forEach(function (p) { counts[p.category] = (counts[p.category] || 0) + 1; });
    var tabs = '<button type="button" class="tab' + (state.view.cat === '' ? ' on' : '') + '" data-cat="">全部 <i>' + state.photos.length + '</i></button>';
    state.cats.forEach(function (c) {
      tabs += '<button type="button" class="tab' + (state.view.cat === c.id ? ' on' : '') + '" data-cat="' + esc(c.id) + '">' + esc(c.zh) + ' <i>' + (counts[c.id] || 0) + '</i></button>';
    });
    $('#tabs').innerHTML = tabs;

    refreshTagLists();

    /* 上傳區 */
    var catObj = state.cats.filter(function (c) { return c.id === state.view.cat; })[0];
    $('#dropText').innerHTML = catObj
      ? '把照片拖到這裡,或 <u>點一下選擇檔案</u>,會加入「<b>' + esc(catObj.zh) + '</b>」'
      : '請先在上方選一個分類,才能上傳照片';
    $('#drop').classList.toggle('off', !catObj);

    /* 照片格 */
    var list = visiblePhotos();
    var reorder = canReorder();
    $('#hint').textContent = reorder
      ? '可以用滑鼠拖曳卡片,或按 ← → 調整這個分類的照片順序(順序就是網站上顯示的順序)。'
      : '想調整順序時,請選一個分類並把標籤篩選設成「全部標籤」。';
    $('#count').textContent = '顯示 ' + list.length + ' 張';
    $('#grid').innerHTML = list.length ? list.map(function (p) { return cardHtml(p, reorder); }).join('') : '<p class="empty">這裡還沒有照片。</p>';
    renderBar();
    renderBulk();
  }

  /* ------------------------------------------------------------- 事件 */
  function cardOf(el) { var c = el.closest('.card'); return c ? { el: c, p: findPhoto(c.getAttribute('data-id')) } : null; }
  function bindEvents() {
    $('#tabs').addEventListener('click', function (e) {
      var b = e.target.closest('.tab');
      if (!b) return;
      state.view.cat = b.getAttribute('data-cat');
      state.view.tag = '*';
      state.selected = {};
      render();
    });
    $('#tagFilter').addEventListener('change', function (e) { state.view.tag = e.target.value; render(); });

    var grid = $('#grid');
    grid.addEventListener('input', function (e) {
      var c = cardOf(e.target);
      if (!c || !c.p) return;
      if (e.target.classList.contains('tag')) {
        c.p.tag = e.target.value.trim();
        renderBar();
      } else if (e.target.classList.contains('cpos')) {
        c.p.coverPos = parseInt(e.target.value, 10);
        $('.posv', c.el).textContent = c.p.coverPos + '%';
        $('img', c.el).style.objectPosition = '50% ' + c.p.coverPos + '%';
        renderBar();
      }
    });
    grid.addEventListener('change', function (e) {
      var c = cardOf(e.target);
      if (!c || !c.p) return;
      var t = e.target;
      if (t.classList.contains('tag')) {
        refreshTagLists();
      } else if (t.classList.contains('feat')) {
        c.p.isFeatured = t.checked;
        syncCard(c.el, c.p);
        renderBar();
      } else if (t.classList.contains('cover')) {
        if (t.checked) {
          state.photos.forEach(function (o) { if (o.category === c.p.category && o !== c.p) o.isCover = false; });
          c.p.isCover = true;
        } else {
          c.p.isCover = false;
        }
        Array.prototype.forEach.call(grid.querySelectorAll('.card'), function (el) {
          var p = findPhoto(el.getAttribute('data-id'));
          if (p) syncCard(el, p);
        });
        renderBar();
      } else if (t.classList.contains('sel')) {
        if (t.checked) state.selected[c.p.id] = true; else delete state.selected[c.p.id];
        c.el.classList.toggle('is-sel', t.checked);
        renderBulk();
      }
    });
    grid.addEventListener('click', function (e) {
      var c = cardOf(e.target);
      if (!c || !c.p) return;
      if (e.target.classList.contains('del')) {
        if (confirm('確定要刪除這張照片嗎?\n(按「發佈到網站」後才會真的從網站移除)')) removePhotos([c.p.id]);
      } else if (e.target.classList.contains('mv-l')) {
        moveBy(c.p.id, -1);
      } else if (e.target.classList.contains('mv-r')) {
        moveBy(c.p.id, 1);
      }
    });

    /* 拖曳排序 */
    var dragId = null;
    grid.addEventListener('dragstart', function (e) {
      var c = cardOf(e.target);
      if (!c || !c.p || !canReorder()) return;
      dragId = c.p.id;
      c.el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragId); } catch (err) {}
    });
    grid.addEventListener('dragend', function () {
      dragId = null;
      Array.prototype.forEach.call(grid.querySelectorAll('.dragging,.dragover'), function (el) { el.classList.remove('dragging', 'dragover'); });
    });
    grid.addEventListener('dragover', function (e) {
      if (!dragId) return;
      var c = cardOf(e.target);
      if (!c) return;
      e.preventDefault();
      Array.prototype.forEach.call(grid.querySelectorAll('.dragover'), function (el) { el.classList.remove('dragover'); });
      c.el.classList.add('dragover');
    });
    grid.addEventListener('drop', function (e) {
      if (!dragId) return;
      var c = cardOf(e.target);
      if (!c || !c.p) return;
      e.preventDefault();
      var id = dragId;
      dragId = null;
      moveTo(id, c.p.id);
    });

    /* 上傳 */
    var drop = $('#drop'), input = $('#fileInput');
    drop.addEventListener('click', function () {
      if (!state.view.cat) { toast('請先在上方選一個分類,再上傳照片', true); return; }
      input.click();
    });
    input.addEventListener('change', function () { handleFiles(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (n) {
      drop.addEventListener(n, function (e) { e.preventDefault(); if (state.view.cat) drop.classList.add('hot'); });
    });
    ['dragleave', 'drop'].forEach(function (n) {
      drop.addEventListener(n, function (e) { e.preventDefault(); drop.classList.remove('hot'); });
    });
    drop.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });

    /* 批次操作 */
    $('#selAll').addEventListener('click', function () {
      visiblePhotos().forEach(function (p) { state.selected[p.id] = true; });
      render();
    });
    $('#bulkClear').addEventListener('click', function () { state.selected = {}; render(); });
    $('#bulkTagBtn').addEventListener('click', function () {
      var v = $('#bulkTag').value.trim();
      Object.keys(state.selected).forEach(function (id) { var p = findPhoto(id); if (p) p.tag = v; });
      $('#bulkTag').value = '';
      render();
      toast(v ? '已把選取的照片標籤設為「' + v + '」' : '已清除選取照片的標籤');
    });
    $('#bulkFeat').addEventListener('click', function () {
      Object.keys(state.selected).forEach(function (id) { var p = findPhoto(id); if (p) p.isFeatured = true; });
      render();
    });
    $('#bulkUnfeat').addEventListener('click', function () {
      Object.keys(state.selected).forEach(function (id) { var p = findPhoto(id); if (p) p.isFeatured = false; });
      render();
    });
    $('#bulkDel').addEventListener('click', function () {
      var ids = Object.keys(state.selected);
      if (ids.length && confirm('確定要刪除選取的 ' + ids.length + ' 張照片嗎?\n(按「發佈到網站」後才會真的從網站移除)')) removePhotos(ids);
    });

    /* 發佈 / 放棄 */
    $('#publishBtn').addEventListener('click', publish);
    $('#discardBtn').addEventListener('click', function () {
      if (!confirm('確定要放棄所有尚未發佈的變更嗎?')) return;
      Object.keys(state.previews).forEach(function (f) { URL.revokeObjectURL(state.previews[f]); });
      state.previews = {};
      state.busy = true;
      loadAll().then(function () { state.busy = false; render(); toast('已放棄變更'); })
        .catch(function (err) { state.busy = false; toast('重新讀取失敗:' + err.message, true); });
    });
    $('#logoutBtn').addEventListener('click', function () {
      if (isDirty() && !confirm('還有尚未發佈的變更,登出後會遺失。確定要登出嗎?')) return;
      try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
      location.reload();
    });
    window.addEventListener('beforeunload', function (e) {
      if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  /* --------------------------------------------------------------- 骨架 */
  var CSS = [
    ':root{--bg:#f6f4ef;--card:#fff;--ink:#1f1c17;--dim:#6f685c;--line:#e2ddd2;--brass:#a67c3c;--brass-d:#8a6630;--red:#b3402f;--green:#3f7d4e}',
    '*{box-sizing:border-box}',
    'body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI","Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif}',
    'button,input,select{font:inherit;color:inherit}',
    '[hidden]{display:none!important}',
    '.top{position:sticky;top:0;z-index:20;background:rgba(246,244,239,.94);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}',
    '.top-in{max-width:1300px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}',
    '.top h1{font-size:18px;margin:0;font-weight:700;letter-spacing:.04em}',
    '.top .sp{flex:1}',
    '.who{color:var(--dim);font-size:13px}',
    '.wrap{max-width:1300px;margin:0 auto;padding:18px 20px 140px}',
    '.btn{border:1px solid var(--line);background:#fff;color:var(--ink);border-radius:8px;padding:8px 14px;cursor:pointer;text-decoration:none;display:inline-block;line-height:1.3}',
    '.btn:hover:not(:disabled){border-color:var(--brass)}',
    '.btn:disabled{opacity:.45;cursor:default}',
    '.btn.primary{background:var(--brass);border-color:var(--brass);color:#fff;font-weight:600}',
    '.btn.primary:hover:not(:disabled){background:var(--brass-d)}',
    '.btn.sm{padding:4px 10px;font-size:13px}',
    '.btn.danger{color:var(--red)}',
    '.tabs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}',
    '.tab{border:1px solid var(--line);background:#fff;border-radius:999px;padding:6px 14px;cursor:pointer}',
    '.tab i{font-style:normal;color:var(--dim);font-size:12px;margin-left:2px}',
    '.tab.on{background:var(--ink);color:#fff;border-color:var(--ink)}.tab.on i{color:#cfc8b8}',
    '.tools{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:10px}',
    '.tools select{border:1px solid var(--line);background:#fff;border-radius:8px;padding:7px 10px}',
    '.tools .count{color:var(--dim);font-size:13px}',
    '.hint{color:var(--dim);font-size:13px;margin:0 0 12px}',
    '.drop{border:2px dashed #cfc7b6;border-radius:12px;padding:22px;text-align:center;color:var(--dim);cursor:pointer;background:#fbfaf6;margin-bottom:16px}',
    '.drop.hot{border-color:var(--brass);background:#f7efe0}',
    '.drop.off{opacity:.6;cursor:not-allowed}',
    '.drop b{color:var(--ink)}',
    '.bulk{display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:#fff;border:1px solid var(--brass);border-radius:10px;padding:10px 12px;margin-bottom:14px}',
    '.bulk input[type=text]{border:1px solid var(--line);border-radius:8px;padding:6px 10px;width:170px}',
    '.bulk .n{font-weight:600;margin-right:6px}',
    '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px}',
    '.card{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;display:flex;flex-direction:column}',
    '.card.is-sel{outline:2px solid var(--brass)}',
    '.card.dragging{opacity:.4}',
    '.card.dragover{outline:2px dashed var(--brass)}',
    '.thumb{position:relative;aspect-ratio:6/5;background:#e9e5da;overflow:hidden}',
    '.thumb img{width:100%;height:100%;object-fit:cover;display:block}',
    '.selbox{position:absolute;left:6px;top:6px;background:rgba(255,255,255,.9);border-radius:6px;padding:2px 5px;line-height:1;cursor:pointer}',
    '.selbox input{width:17px;height:17px;margin:0;cursor:pointer}',
    '.badges{position:absolute;right:6px;top:6px;display:flex;gap:4px}',
    '.bd{display:none;font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;color:#fff}',
    '.bd-new{background:var(--green)}.bd-cover{background:var(--brass)}.bd-feat{background:var(--ink)}',
    '.card.is-new .bd-new,.card.is-cover .bd-cover,.card.is-feat .bd-feat{display:inline-block}',
    '.body{padding:10px;display:flex;flex-direction:column;gap:8px}',
    '.tag{width:100%;border:1px solid var(--line);border-radius:8px;padding:6px 9px}',
    '.row2{display:flex;justify-content:space-between;align-items:center;gap:8px}',
    '.chk{display:flex;align-items:center;gap:5px;font-size:14px;cursor:pointer}',
    '.pos{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dim)}',
    '.pos input{flex:1;min-width:0}',
    '.posv{width:38px;text-align:right}',
    '.empty{color:var(--dim);grid-column:1/-1;text-align:center;padding:40px 0}',
    '.bar{position:fixed;left:0;right:0;bottom:0;z-index:30;background:#fff;border-top:1px solid var(--line);box-shadow:0 -4px 16px rgba(0,0,0,.06)}',
    '.bar.dirty{border-top:2px solid var(--brass)}',
    '.bar-in{max-width:1300px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}',
    '.bar-in .t{flex:1;min-width:200px}',
    '.bar-in .s{color:var(--brass-d);font-size:13px}',
    '.toast{position:fixed;left:50%;bottom:86px;transform:translateX(-50%) translateY(20px);background:var(--ink);color:#fff;padding:10px 18px;border-radius:10px;opacity:0;pointer-events:none;transition:.25s;z-index:50;max-width:min(92vw,560px);text-align:center}',
    '.toast.show{opacity:1;transform:translateX(-50%)}',
    '.toast.err{background:var(--red)}',
    '.login{max-width:420px;margin:12vh auto;background:#fff;border:1px solid var(--line);border-radius:14px;padding:32px;text-align:center}',
    '.login h1{font-size:20px;margin:0 0 8px}',
    '.login p{color:var(--dim);margin:0 0 20px}',
    '.login .err{color:var(--red);margin-top:14px;font-size:14px}',
    '@media(max-width:560px){.wrap{padding:14px 12px 150px}.grid{grid-template-columns:repeat(2,1fr);gap:10px}.top-in{padding:10px 12px}}'
  ].join('\n');

  var SHELL = '<div class="top"><div class="top-in"><h1>澤日影像 · 照片管理</h1><span class="sp"></span>' +
    '<span class="who" id="who"></span>' +
    '<a class="btn sm" href="/admin/" target="_blank" rel="noopener">編輯分類 / 常見問題</a>' +
    '<button class="btn sm" id="logoutBtn" type="button">登出</button></div></div>' +
    '<div class="wrap">' +
      '<div class="tabs" id="tabs"></div>' +
      '<div class="tools"><select id="tagFilter"></select><span class="count" id="count"></span>' +
        '<button class="btn sm" id="selAll" type="button">全選目前顯示的</button></div>' +
      '<p class="hint" id="hint"></p>' +
      '<div class="drop" id="drop"><span id="dropText"></span></div>' +
      '<input type="file" id="fileInput" accept="image/*" multiple hidden>' +
      '<div class="bulk" id="bulk" hidden><span class="n" id="bulkCount"></span>' +
        '<input type="text" id="bulkTag" list="taglist" maxlength="30" placeholder="輸入標籤">' +
        '<button class="btn sm" id="bulkTagBtn" type="button">套用標籤</button>' +
        '<button class="btn sm" id="bulkFeat" type="button">設為精選</button>' +
        '<button class="btn sm" id="bulkUnfeat" type="button">取消精選</button>' +
        '<button class="btn sm danger" id="bulkDel" type="button">刪除選取</button>' +
        '<button class="btn sm" id="bulkClear" type="button">取消選取</button></div>' +
      '<div class="grid" id="grid"></div>' +
      '<datalist id="taglist"></datalist>' +
    '</div>' +
    '<div class="bar" id="bar"><div class="bar-in"><div class="t"><div id="barText"></div><div class="s" id="status"></div></div>' +
      '<button class="btn" id="discardBtn" type="button">放棄變更</button>' +
      '<button class="btn primary" id="publishBtn" type="button">發佈到網站</button></div></div>' +
    '<div class="toast" id="toast"></div>';

  function mount() {
    document.title = '澤日影像 照片管理';
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    var root = document.getElementById('app') || document.body;
    root.innerHTML = '<div id="loginView"></div><div id="mainView" hidden>' + SHELL + '</div>';
  }
  function showLogin(msg) {
    $('#mainView').hidden = true;
    var v = $('#loginView');
    v.innerHTML = '<div class="login"><h1>澤日影像 · 照片管理</h1>' +
      '<p>請用有這個網站編輯權限的 GitHub 帳號登入。</p>' +
      '<button class="btn primary" id="loginBtn" type="button">使用 GitHub 登入</button>' +
      (msg ? '<div class="err">' + esc(msg) + '</div>' : '') + '</div>';
    $('#loginBtn').addEventListener('click', function () {
      var b = $('#loginBtn');
      b.disabled = true;
      b.textContent = '登入中…';
      netlifyLogin().then(function (data) {
        token = data.token;
        try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {}
        return start();
      }).catch(function (err) { showLogin(err.message); });
    });
  }
  function start() {
    $('#loginView').innerHTML = '<div class="login"><p>載入中…</p></div>';
    return Promise.all([api('/user'), api('/repos/' + REPO)]).then(function (res) {
      var user = res[0], repo = res[1];
      if (!repo.permissions || !repo.permissions.push) {
        token = null;
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
        throw new Error('這個 GitHub 帳號(' + user.login + ')沒有編輯這個網站的權限,請改用有權限的帳號登入。');
      }
      state.user = user;
      return loadAll();
    }).then(function () {
      $('#loginView').innerHTML = '';
      $('#mainView').hidden = false;
      $('#who').textContent = state.user.login;
      if (!state.view.cat && state.cats.length) state.view.cat = state.cats[0].id;
      render();
    }).catch(function (err) { showLogin(err.message); });
  }

  mount();
  bindEvents();
  if (token) start(); else showLogin();
})();
