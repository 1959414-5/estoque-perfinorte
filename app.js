// ============================================================
// API — wrapper que fala com o Apps Script via HTTP.
// Substitui o antigo google.script.run.
// ============================================================
async function api(acao, params) {
  if (!window.APP_CONFIG || !window.APP_CONFIG.API_URL || window.APP_CONFIG.API_URL.indexOf('COLE_AQUI') === 0) {
    throw new Error('config.js não foi editado. Cole a URL do Apps Script e o token lá.');
  }
  const body = Object.assign({ acao: acao, token: window.APP_CONFIG.APP_TOKEN }, params || {});
  const resp = await fetch(window.APP_CONFIG.API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
    redirect: 'follow'
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const j = await resp.json();
  if (!j.ok) throw new Error(j.erro || 'Erro desconhecido');
  return j.dados;
}


let CONFIG = { status: [], linhas: [], solicitantes: [] };
let CATALOGO = [];
let SOLICITACOES = [];

let PECA_IMAGEM_BASE64 = null;    // nova foto anexada no form de peça (se trocou)
let PECA_IMAGEM_URL_ATUAL = '';   // url já existente da peça (se editando)
let MODO_PECA_ORIGEM = 'catalogo'; // 'catalogo' | 'solicitacao' — de onde abriu o form de peça

let FILTRO_STATUS = 'Todos';
let FILTRO_LINHA_PICKER = 'Todas';
let FILTRO_LINHA_CATALOGO = 'Todas';
let MOVIMENTO_PECA_ATUAL = null;
let MOVIMENTO_TIPO_ATUAL = 'entrada';

// ---------------------------------------------------------
// INIT
// ---------------------------------------------------------
document.addEventListener('DOMContentLoaded', function () {
  api('getConfig')
    .then(function (cfg) {
      CONFIG = cfg;
      montarSelectSolicitantes();
      montarSelectLinhaPeca();
      montarChipsLinha('picker-linha-chips', filtrarPickerPeca, 'FILTRO_LINHA_PICKER');
      montarChipsLinha('catalogo-linha-chips', renderCatalogoLista, 'FILTRO_LINHA_CATALOGO');
    })
    .catch(function (err) {
      toast('Erro ao carregar configuração: ' + err.message);
    });

  document.getElementById('lista-catalogo').innerHTML = '<div class="empty-state">Carregando peças...</div>';
  carregarCatalogo();
  carregarSolicitacoes();
  atualizarBotaoModoAdmin();

  const abaSalva = localStorage.getItem('abaAtual');
  if (abaSalva && document.getElementById('view-' + abaSalva)) {
    trocarView(abaSalva);
  }

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => trocarView(btn.dataset.view));
  });

  document.getElementById('peca-foto-camera').addEventListener('change', e => handleFotoChange(e, 'peca'));
  document.getElementById('inp-confirmacao-camera').addEventListener('change', handleConfirmacaoPedido);
  document.getElementById('inp-confirmacao-arquivo').addEventListener('change', handleConfirmacaoPedido);
  document.getElementById('peca-foto-arquivo').addEventListener('change', e => handleFotoChange(e, 'peca'));

  document.getElementById('form-nova').addEventListener('submit', enviarSolicitacao);
  document.getElementById('form-peca').addEventListener('submit', salvarPecaCatalogo);

  document.getElementById('inp-busca-catalogo').addEventListener('input', renderCatalogoLista);
  document.getElementById('inp-busca-picker').addEventListener('input', filtrarPickerPeca);
  document.getElementById('peca-id-input').addEventListener('blur', verificarIdDuplicado);
  document.getElementById('inp-foto-qr').addEventListener('change', handleFotoQR);
});

function trocarView(nome) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('view-active'));
  document.getElementById('view-' + nome).classList.add('view-active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('nav-active', b.dataset.view === nome));
  localStorage.setItem('abaAtual', nome);
  if (nome === 'painel') carregarSolicitacoes();
  if (nome === 'catalogo') carregarCatalogo();
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------------------------------------------------------
// CONFIG — selects / chips dinâmicos
// ---------------------------------------------------------
function montarSelectSolicitantes() {
  const sel = document.getElementById('sel-solicitante');
  sel.innerHTML = CONFIG.solicitantes.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');
  const salvo = localStorage.getItem('nomeUsuario');
  if (salvo && CONFIG.solicitantes.indexOf(salvo) !== -1) {
    sel.value = salvo;
  } else {
    sel.selectedIndex = 0; // primeiro da lista (João Paulo) como padrão
  }
}

function montarSelectLinhaPeca() {
  const sel = document.getElementById('peca-linha');
  sel.innerHTML = CONFIG.linhas.map(l => '<option value="' + esc(l) + '">' + esc(l) + '</option>').join('');
}

function montarChipsLinha(containerId, onChangeFn, filtroVarName) {
  const wrap = document.getElementById(containerId);
  const opcoes = ['Todas'].concat(CONFIG.linhas);
  wrap.innerHTML = opcoes.map((l, i) =>
    '<div class="filter-chip' + (i === 0 ? ' selected' : '') + '" data-linha="' + esc(l) + '">' + esc(l) + '</div>'
  ).join('');
  wrap.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      wrap.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
      if (filtroVarName === 'FILTRO_LINHA_PICKER') FILTRO_LINHA_PICKER = chip.dataset.linha;
      if (filtroVarName === 'FILTRO_LINHA_CATALOGO') FILTRO_LINHA_CATALOGO = chip.dataset.linha;
      onChangeFn();
    });
  });
}

// ---------------------------------------------------------
// CATÁLOGO — carregamento
// ---------------------------------------------------------
function carregarCatalogo() {
  api('getCatalogo')
    .then(function (lista) {
      CATALOGO = lista || [];
      renderCatalogoLista();
      if (CATALOGO.length === 0) rodarDiagnosticoCatalogo();
      if (document.getElementById('modal-picker-peca').classList.contains('hidden') === false) {
        filtrarPickerPeca();
      }
    })
    .catch(function (err) {
      document.getElementById('lista-catalogo').innerHTML =
        '<div class="empty-state"><div class="big">Erro ao carregar</div>' + esc(err.message) + '</div>';
      toast('Erro ao carregar catálogo: ' + err.message);
    });
}

function rodarDiagnosticoCatalogo() {
  api('diagnosticoCatalogo')
    .then(function (info) {
      if (CATALOGO.length > 0) return; // carregou algo enquanto isso, ignora
      const wrap = document.getElementById('lista-catalogo');
      wrap.innerHTML =
        '<div class="empty-state">' +
        '<div class="big">Nenhuma peça encontrada pelo servidor</div>' +
        'Manda um print disso pra mim:' +
        '<pre style="text-align:left; background:#fff; border:1px solid var(--line); border-radius:8px; padding:10px; margin-top:10px; font-size:11px; white-space:pre-wrap; overflow-wrap:anywhere;">' +
        esc(JSON.stringify(info, null, 2)) +
        '</pre></div>';
    })
    .catch(function (err) {
      const wrap = document.getElementById('lista-catalogo');
      wrap.innerHTML += '<div class="empty-state">Diagnóstico também falhou: ' + esc(err.message) + '</div>';
    });
}

function thumbHtml(imagemUrl, tamanhoClasse) {
  tamanhoClasse = tamanhoClasse || 'thumb';
  if (imagemUrl) {
    return '<img class="' + tamanhoClasse + '" src="' + imagemUrl + '" onclick="event.stopPropagation(); abrirImagemFullscreen(\'' + imagemUrl.replace(/'/g, "\\'") + '\')">';
  }
  return '<div class="' + tamanhoClasse + '-placeholder">▭</div>';
}

let LIGHTBOX_ROTACAO = 0;

function abrirImagemFullscreen(url) {
  LIGHTBOX_ROTACAO = 0;
  const img = document.getElementById('lightbox-img');
  img.src = url;
  img.style.transform = 'rotate(0deg)';
  document.getElementById('modal-lightbox').classList.remove('hidden');
}

function rotacionarImagemFullscreen(graus) {
  LIGHTBOX_ROTACAO = (LIGHTBOX_ROTACAO + graus + 360) % 360;
  document.getElementById('lightbox-img').style.transform = 'rotate(' + LIGHTBOX_ROTACAO + 'deg)';
}

function fecharImagemFullscreen() {
  document.getElementById('modal-lightbox').classList.add('hidden');
  document.getElementById('lightbox-img').src = '';
}

// ---------------------------------------------------------
// SELETOR DE PEÇA (Nova Solicitação)
// ---------------------------------------------------------
let PICKER_CALLBACK = null;

function abrirPickerPeca(callback) {
  PICKER_CALLBACK = callback;
  document.getElementById('inp-busca-picker').value = '';
  FILTRO_LINHA_PICKER = 'Todas';
  document.querySelectorAll('#picker-linha-chips .filter-chip').forEach((c, i) => c.classList.toggle('selected', i === 0));
  filtrarPickerPeca();
  document.getElementById('modal-picker-peca').classList.remove('hidden');
}

function fecharPickerPeca() {
  document.getElementById('modal-picker-peca').classList.add('hidden');
}

function filtrarPickerPeca() {
  const termo = (document.getElementById('inp-busca-picker').value || '').toLowerCase();
  const wrap = document.getElementById('lista-picker');
  let filtradas = CATALOGO.filter(p =>
    (p.Nome_Peca || '').toLowerCase().includes(termo) ||
    String(p.ID_Peca || '').toLowerCase().includes(termo)
  );
  if (FILTRO_LINHA_PICKER !== 'Todas') filtradas = filtradas.filter(p => p.Linha === FILTRO_LINHA_PICKER);

  wrap.innerHTML = '';
  if (filtradas.length === 0) {
    wrap.innerHTML = '<div class="empty-state">Nenhuma peça encontrada.</div>';
    return;
  }
  filtradas.slice(0, 60).forEach(p => {
    const div = document.createElement('div');
    div.className = 'picker-item';
    div.style.cursor = 'pointer';
    div.innerHTML = thumbHtml(p.Imagem_URL) +
      '<div class="picker-item-text">' +
      '<div class="picker-item-title">' + esc(p.Nome_Peca) + '</div>' +
      '<div class="picker-item-sub">' + esc(p.MP || '') + (p.Espessura ? ' · ' + esc(formatarEspessura(p.Espessura)) : '') + ' · ' + esc(p.Linha || '') + '</div>' +
      '</div>';
    div.addEventListener('click', () => {
      fecharPickerPeca();
      if (PICKER_CALLBACK) PICKER_CALLBACK(p);
    });
    wrap.appendChild(div);
  });
}

// ---------------------------------------------------------
// MODAL NOVA/EDITAR PEÇA
// ---------------------------------------------------------
function abrirModalPecaNova(origem) {
  MODO_PECA_ORIGEM = origem || 'catalogo';
  document.getElementById('form-peca').reset();
  document.getElementById('peca-id-edicao').value = '';
  document.getElementById('peca-id-input').value = '';
  document.getElementById('peca-id-input').disabled = false;
  document.getElementById('peca-id-input').classList.remove('id-invalido');
  document.getElementById('peca-id-aviso').textContent = '';
  PECA_IMAGEM_BASE64 = null;
  PECA_IMAGEM_URL_ATUAL = '';
  document.getElementById('peca-imagem-preview').style.display = 'none';
  document.getElementById('btn-remover-peca').style.display = 'none';
  document.getElementById('btn-imprimir-etiqueta').style.display = 'none';
  document.getElementById('campo-peca-ativo').style.display = 'none';
  document.getElementById('peca-ativo').checked = true;
  document.getElementById('peca-estoque-atual').value = '';
  document.getElementById('peca-estoque-minimo').value = '';
  document.getElementById('modal-peca-titulo').textContent = 'Nova peça no catálogo';
  document.getElementById('modal-peca').classList.remove('hidden');
}

function abrirModalPecaDoPicker() {
  fecharPickerPeca();
  abrirModalPecaNova('solicitacao');
}

function fecharModalPeca() {
  document.getElementById('modal-peca').classList.add('hidden');
}

function editarPecaExistente(id) {
  const p = CATALOGO.find(x => x.ID_Peca === id);
  if (!p) return;
  MODO_PECA_ORIGEM = 'catalogo';
  document.getElementById('peca-id-edicao').value = p.ID_Peca;
  document.getElementById('peca-id-input').value = p.ID_Peca || '';
  document.getElementById('peca-id-input').disabled = true;
  document.getElementById('peca-id-input').classList.remove('id-invalido');
  document.getElementById('peca-id-aviso').textContent = '';
  document.getElementById('peca-nome').value = p.Nome_Peca || '';
  document.getElementById('peca-linha').value = p.Linha || CONFIG.linhas[0];
  document.getElementById('peca-mp').value = p.MP || '';
  document.getElementById('peca-espessura').value = p.Espessura || '';
  document.getElementById('peca-servicos').value = p.Servicos || '';
  document.getElementById('peca-obs').value = p.Observacoes || '';
  document.getElementById('peca-largura').value = p['Largura do Produto'] || '';
  document.getElementById('peca-comprimento').value = p['Comprimento do Produto'] || '';
  document.getElementById('peca-estoque-atual').value = p['Estoque_Atual'] || 0;
  document.getElementById('peca-estoque-minimo').value = p['Estoque_Minimo'] || 0;
  document.getElementById('campo-peca-ativo').style.display = 'block';
  document.getElementById('peca-ativo').checked = p.Ativo !== false;

  PECA_IMAGEM_BASE64 = null;
  PECA_IMAGEM_URL_ATUAL = p.Imagem_URL || '';
  const preview = document.getElementById('peca-imagem-preview');
  if (PECA_IMAGEM_URL_ATUAL) { preview.src = PECA_IMAGEM_URL_ATUAL; preview.style.display = 'block'; }
  else { preview.style.display = 'none'; }

  document.getElementById('btn-remover-peca').style.display = 'block';
  document.getElementById('btn-imprimir-etiqueta').style.display = 'block';
  document.getElementById('modal-peca-titulo').textContent = 'Editar peça';
  document.getElementById('modal-peca').classList.remove('hidden');
}

function verificarIdDuplicado() {
  const idEdicao = document.getElementById('peca-id-edicao').value;
  if (idEdicao) return; // editando — ID travado, não precisa checar
  const id = document.getElementById('peca-id-input').value.trim();
  const campo = document.getElementById('peca-id-input');
  const aviso = document.getElementById('peca-id-aviso');
  if (!id) { campo.classList.remove('id-invalido'); aviso.textContent = ''; return; }
  api('pecaIdExiste', { id: id })
    .then(function (existe) {
      if (existe) {
        campo.classList.add('id-invalido');
        aviso.textContent = 'Esse ID já existe no catálogo.';
      } else {
        campo.classList.remove('id-invalido');
        aviso.textContent = '';
      }
    })
    .catch(function () { /* checagem best-effort, não bloqueia digitação */ });
}

function salvarPecaCatalogo(e) {
  e.preventDefault();
  const idEdicao = document.getElementById('peca-id-edicao').value;
  const idDigitado = document.getElementById('peca-id-input').value.trim();
  const peca = {
    id: idEdicao || idDigitado,
    nome: document.getElementById('peca-nome').value.trim(),
    linha: document.getElementById('peca-linha').value,
    mp: document.getElementById('peca-mp').value.trim(),
    espessura: document.getElementById('peca-espessura').value.trim(),
    servicos: document.getElementById('peca-servicos').value.trim(),
    observacoes: document.getElementById('peca-obs').value.trim(),
    largura: document.getElementById('peca-largura').value.trim(),
    comprimento: document.getElementById('peca-comprimento').value.trim(),
    estoqueAtual: document.getElementById('peca-estoque-atual').value.trim(),
    estoqueMinimo: document.getElementById('peca-estoque-minimo').value.trim(),
    ativo: document.getElementById('peca-ativo').checked,
    imagemUrl: PECA_IMAGEM_URL_ATUAL,
    imagemBase64: PECA_IMAGEM_BASE64
  };
  if (!idEdicao && !idDigitado) { toast('Informe o ID da peça'); return; }
  if (!peca.nome) { toast('Dê um nome pra peça'); return; }

  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;

  if (idEdicao) {
    api('editarPeca', { peca: peca })
    .then(function () {
        toast('Peça atualizada');
        fecharModalPeca();
        carregarCatalogo();
        btn.disabled = false;
      })
    .catch(function (err) {
        toast('Erro ao atualizar: ' + err.message);
        btn.disabled = false;
      });
  } else {
    api('salvarPeca', { peca: peca })
    .then(function (resultado) {
        toast('Peça cadastrada');
        fecharModalPeca();
        carregarCatalogo();
        if (MODO_PECA_ORIGEM === 'solicitacao' && PICKER_CALLBACK) {
          PICKER_CALLBACK({
            ID_Peca: resultado.id, Nome_Peca: resultado.nome,
            MP: resultado.mp, Espessura: resultado.espessura,
            Linha: resultado.linha, Imagem_URL: resultado.imagemUrl
          });
        }
        btn.disabled = false;
      })
    .catch(function (err) {
        toast('Erro: ' + err.message);
        btn.disabled = false;
      });
  }
}

function inativarPecaAtual(id) {
  if (!confirm('Remover essa peça do catálogo ativo?')) return;
  api('inativarPeca', { idPeca: id })
    .then(function () {
      toast('Peça removida do catálogo');
      fecharModalPeca();
      carregarCatalogo();
    })
    .catch(function (err) { toast('Erro: ' + err.message); });
}

function renderCatalogoLista() {
  const termo = (document.getElementById('inp-busca-catalogo').value || '').toLowerCase();
  const wrap = document.getElementById('lista-catalogo');
  let filtradas = CATALOGO.filter(p =>
    (p.Nome_Peca || '').toLowerCase().includes(termo) ||
    String(p.ID_Peca || '').toLowerCase().includes(termo)
  );
  if (FILTRO_LINHA_CATALOGO !== 'Todas') filtradas = filtradas.filter(p => p.Linha === FILTRO_LINHA_CATALOGO);

  wrap.innerHTML = '';
  if (filtradas.length === 0) {
    wrap.innerHTML = '<div class="empty-state"><div class="big">Nada encontrado</div>' +
      (CATALOGO.length === 0 ? 'Nenhuma peça carregada ainda.' : 'Cadastre pelo botão +') + '</div>';
    return;
  }
  filtradas.forEach(p => {
    const largura = p['Largura do Produto'];
    const comprimento = p['Comprimento do Produto'];
    const estoqueAtual = Number(p['Estoque_Atual'] || 0);
    const estoqueMinimo = Number(p['Estoque_Minimo'] || 0);

    let nivel = 'ok';
    if (estoqueAtual <= 0) nivel = 'zero';
    else if (estoqueAtual <= estoqueMinimo) nivel = 'baixo';

    const imgInner = p.Imagem_URL
      ? '<img src="' + p.Imagem_URL + '" onclick="event.stopPropagation(); abrirImagemFullscreen(\'' + p.Imagem_URL.replace(/'/g, "\\'") + '\')">'
      : '<div class="thumb-lg-placeholder">▭</div>';

    const div = document.createElement('div');
    div.className = 'catalog-card-v2';
    div.innerHTML =
      '<div class="catalog-card-v2-imgwrap">' + imgInner +
      '<span class="peca-linha-badge catalog-card-v2-badge">' + esc(p.Linha || '—') + '</span>' +
      '</div>' +
      '<div class="catalog-card-v2-body">' +
      '<div class="catalog-card-id">' + esc(p.ID_Peca) + '</div>' +
      '<div class="catalog-card-name">' + esc(p.Nome_Peca) + '</div>' +
      '<div class="catalog-card-line">' + esc(p.MP || '—') + (p.Espessura ? ' · ' + esc(formatarEspessura(p.Espessura)) : '') + '</div>' +
      ((largura || comprimento) ? '<div class="catalog-card-line catalog-card-dim">L ' + esc(largura || '—') + ' × C ' + esc(comprimento || '—') + '</div>' : '') +
      (p.Servicos ? '<span class="servicos-tag">' + esc(p.Servicos) + '</span>' : '') +
      '<div class="stock-box stock-' + nivel + '">' +
      '<div class="stock-num">' + estoqueAtual + '</div>' +
      '<div class="stock-label">' + (nivel === 'zero' ? 'SEM ESTOQUE' : nivel === 'baixo' ? 'ESTOQUE BAIXO' : 'EM ESTOQUE') + '</div>' +
      '</div>' +
      '<div class="catalog-card-quick-actions">' +
      '<button type="button" class="quick-action-btn quick-entrada" onclick="event.stopPropagation(); abrirMovimentoRapido(\'' + p.ID_Peca + '\', \'entrada\')">+ Entrada</button>' +
      '<button type="button" class="quick-action-btn quick-saida" onclick="event.stopPropagation(); abrirMovimentoRapido(\'' + p.ID_Peca + '\', \'saida\')">− Saída</button>' +
      '</div>' +
      '</div>';
    div.addEventListener('click', () => editarPecaExistente(p.ID_Peca));
    wrap.appendChild(div);
  });
}

// ---------------------------------------------------------
// FOTOS (comum: solicitação e peça)
// ---------------------------------------------------------
// Reduz uma imagem base64 pra no máximo 1600px no maior lado.
// Isso mantém qualidade suficiente pra referência e evita payload gigante.
function redimensionarBase64(base64, maxDim, callback) {
  const img = new Image();
  img.onload = function () {
    let w = img.width, h = img.height;
    if (w <= maxDim && h <= maxDim) { callback(base64); return; }
    if (w >= h) { h = Math.round(h * maxDim / w); w = maxDim; }
    else { w = Math.round(w * maxDim / h); h = maxDim; }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    callback(canvas.toDataURL('image/jpeg', 0.85));
  };
  img.onerror = function () { callback(base64); };
  img.src = base64;
}

function handleFotoChange(e, alvo) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (ev) {
    redimensionarBase64(ev.target.result, 1600, function (reduzida) {
      PECA_IMAGEM_BASE64 = reduzida;
      const img = document.getElementById('peca-imagem-preview');
      img.src = PECA_IMAGEM_BASE64;
      img.style.display = 'block';
    });
  };
  reader.readAsDataURL(file);
}

// ---------------------------------------------------------
// NOVA SOLICITAÇÃO — múltiplos itens, cada um com peça/qtd/urgente/fotos
// ---------------------------------------------------------
let ITENS_SOLICITACAO = [];
let PROXIMO_ITEM_UID = 1;

function novoItemVazio() {
  return { uid: 'it' + (PROXIMO_ITEM_UID++), peca: null, quantidade: 1, urgente: false, fotos: [], observacao: '' };
}

function acharItemSolicitacao(uid) {
  return ITENS_SOLICITACAO.find(it => it.uid === uid);
}

function adicionarItemSolicitacao() {
  ITENS_SOLICITACAO.push(novoItemVazio());
  renderItensSolicitacao();
}

function removerItemSolicitacao(uid) {
  if (ITENS_SOLICITACAO.length <= 1) { toast('Precisa ter pelo menos uma peça'); return; }
  ITENS_SOLICITACAO = ITENS_SOLICITACAO.filter(it => it.uid !== uid);
  renderItensSolicitacao();
}

function atualizarQtdItem(uid, valor) {
  const item = acharItemSolicitacao(uid);
  if (item) item.quantidade = Math.max(1, Number(valor) || 1);
}

function atualizarUrgenteItem(uid, valor) {
  const item = acharItemSolicitacao(uid);
  if (item) item.urgente = valor;
}

function atualizarObsItem(uid, valor) {
  const item = acharItemSolicitacao(uid);
  if (item) item.observacao = valor;
}

function abrirPickerParaItem(uid) {
  abrirPickerPeca(function (p) {
    const item = acharItemSolicitacao(uid);
    if (item) { item.peca = p; renderItensSolicitacao(); }
  });
}

function abrirScanParaItem(uid) {
  abrirScanQR(function (p) {
    const item = acharItemSolicitacao(uid);
    if (item) { item.peca = p; renderItensSolicitacao(); }
  });
}

function removerFotoItem(uid, idx) {
  const item = acharItemSolicitacao(uid);
  if (item) { item.fotos.splice(idx, 1); renderItensSolicitacao(); }
}

function renderItensSolicitacao() {
  const wrap = document.getElementById('itens-solicitacao');
  wrap.innerHTML = ITENS_SOLICITACAO.map((item, idx) => renderItemSolicitacaoCard(item, idx)).join('');
}

function renderItemSolicitacaoCard(item, idx) {
  const p = item.peca;
  const pickerIcon = p ? (p.Imagem_URL ? '<img src="' + p.Imagem_URL + '">' : '▭') : '🔍';
  const subInfo = p ? esc((p.MP || '') + (p.Espessura ? ' · ' + formatarEspessura(p.Espessura) : '') + (p.Linha ? ' · ' + p.Linha : '')) : '';

  const fotosHtml = item.fotos.map((foto, fi) =>
    '<div class="photo-preview-item"><img src="' + foto + '">' +
    '<button type="button" class="photo-preview-remove" onclick="removerFotoItem(\'' + item.uid + '\',' + fi + ')">×</button></div>'
  ).join('');

  return '<div class="item-card">' +
    '<div class="item-card-head">' +
    '<span class="item-card-titulo">Peça ' + (idx + 1) + '</span>' +
    (ITENS_SOLICITACAO.length > 1 ? '<button type="button" class="item-remove-btn" onclick="removerItemSolicitacao(\'' + item.uid + '\')">🗑 remover</button>' : '') +
    '</div>' +

    '<div class="field">' +
    '<div class="item-picker-row">' +
    '<button type="button" class="peca-picker-btn' + (p ? ' filled' : '') + '" onclick="abrirPickerParaItem(\'' + item.uid + '\')">' +
    '<span class="peca-picker-btn-icon">' + pickerIcon + '</span>' +
    '<span class="peca-picker-btn-text">' +
    (p
      ? '<span class="item-id-confirm">ID: ' + esc(p.ID_Peca) + '</span><span class="peca-picker-btn-title">' + esc(p.Nome_Peca) + '</span><br><span class="peca-picker-btn-sub">' + subInfo + '</span>'
      : '<span class="peca-picker-btn-placeholder">Toque para buscar a peça</span>') +
    '</span>' +
    '<span class="peca-picker-chevron">›</span>' +
    '</button>' +
    '<button type="button" class="item-scan-btn" onclick="abrirScanParaItem(\'' + item.uid + '\')" title="Escanear QR">📷</button>' +
    '</div>' +
    '</div>' +

    '<div class="field">' +
    '<label>Quantidade</label>' +
    '<input type="number" min="1" inputmode="numeric" value="' + item.quantidade + '" oninput="atualizarQtdItem(\'' + item.uid + '\', this.value)">' +
    '</div>' +

    '<div class="field">' +
    '<label class="urgent-label">' +
    '<input type="checkbox" ' + (item.urgente ? 'checked' : '') + ' onchange="atualizarUrgenteItem(\'' + item.uid + '\', this.checked)">' +
    '<span class="urgent-box">🔴 Marcar como urgente</span>' +
    '</label>' +
    '</div>' +

    '<div class="field">' +
    '<label>Fotos desta peça (opcional)</label>' +
    '<div class="photo-buttons-row">' +
    '<div class="photo-input"><input type="file" accept="image/*" capture="environment" class="item-foto-input" data-uid="' + item.uid + '"> 📷 Tirar foto</div>' +
    '<div class="photo-input"><input type="file" accept="image/*" multiple class="item-foto-input" data-uid="' + item.uid + '"> 🖼️ Escolher arquivo(s)</div>' +
    '</div>' +
    '<div class="photos-preview-row">' + fotosHtml + '</div>' +
    '</div>' +

    '<div class="field">' +
    '<label>Observação desta peça (opcional)</label>' +
    '<input type="text" value="' + esc(item.observacao) + '" placeholder="Opcional..." oninput="atualizarObsItem(\'' + item.uid + '\', this.value)">' +
    '</div>' +
    '</div>';
}

// Delegação de evento: os inputs de foto são recriados a cada render,
// então escuta no container fixo em vez de em cada input individualmente.
document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('itens-solicitacao').addEventListener('change', function (e) {
    if (!e.target.classList.contains('item-foto-input')) return;
    const uid = e.target.dataset.uid;
    const item = acharItemSolicitacao(uid);
    if (!item) return;
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    let restantes = files.length;
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = function (ev) {
        redimensionarBase64(ev.target.result, 1600, function (reduzida) {
          item.fotos.push(reduzida);
          restantes--;
          if (restantes === 0) renderItensSolicitacao();
        });
      };
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  });

  ITENS_SOLICITACAO = [novoItemVazio()];
  renderItensSolicitacao();
});

async function enviarSolicitacao(e) {
  e.preventDefault();
  const solicitante = document.getElementById('sel-solicitante').value;
  if (!solicitante) { toast('Selecione seu nome'); return; }

  for (const item of ITENS_SOLICITACAO) {
    if (!item.peca) { toast('Selecione a peça em todas as linhas'); return; }
    if (!item.quantidade || item.quantidade <= 0) { toast('Quantidade inválida em alguma peça'); return; }
  }

  localStorage.setItem('nomeUsuario', solicitante);
  const observacao = document.getElementById('inp-observacao').value.trim();
  const pedidoId = 'PED' + Date.now();

  const btn = document.getElementById('btn-enviar');
  btn.disabled = true;

  try {
    for (let i = 0; i < ITENS_SOLICITACAO.length; i++) {
      const item = ITENS_SOLICITACAO[i];
      btn.innerHTML = '<span class="spinner"></span> Enviando ' + (i + 1) + '/' + ITENS_SOLICITACAO.length + '...';
      const obsCombinada = [observacao, item.observacao].filter(Boolean).join(' | ');
      await api('salvarSolicitacao', {
        dados: {
          pedidoId: pedidoId,
          solicitante: solicitante,
          idPeca: item.peca.ID_Peca,
          nomePeca: item.peca.Nome_Peca,
          quantidade: item.quantidade,
          observacao: obsCombinada,
          urgente: item.urgente,
          fotos: item.fotos
        }
      });
    }
    toast('Solicitação enviada! (' + ITENS_SOLICITACAO.length + (ITENS_SOLICITACAO.length > 1 ? ' peças)' : ' peça)'));
    document.getElementById('inp-observacao').value = '';
    ITENS_SOLICITACAO = [novoItemVazio()];
    renderItensSolicitacao();
    document.getElementById('sel-solicitante').value = solicitante;
    btn.disabled = false;
    btn.textContent = 'Enviar solicitação';
    trocarView('painel');
  } catch (err) {
    toast('Erro ao enviar: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Enviar solicitação';
  }
}

// ---------------------------------------------------------
// PAINEL — agrupado por PEDIDO (vários itens juntos)
// ---------------------------------------------------------
const STATUS_ORDEM = ['Solicitado', 'Em produção', 'Pronto', 'Entregue'];
let PEDIDOS_CACHE = [];
let PEDIDO_DETALHE_ATUAL = null;
let MODO_ADMIN = localStorage.getItem('modoAdmin') === 'true';

function carregarSolicitacoes() {
  // Busca tudo (sem filtrar por status no servidor) — o filtro por status
  // agora é aplicado no nível do PEDIDO depois de agrupar os itens.
  api('getSolicitacoes', {})
    .then(function (lista) {
      SOLICITACOES = lista || [];
      renderPainel();
    })
    .catch(function (err) {
      document.getElementById('lista-painel').innerHTML =
        '<div class="empty-state"><div class="big">Erro ao carregar</div>' + esc(err.message) + '</div>';
      toast('Erro ao carregar painel: ' + err.message);
    });
}

function setFiltro(status, el) {
  FILTRO_STATUS = status;
  document.querySelectorAll('#status-filter-row .filter-chip').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  renderPainel();
}

function pecaThumbPorId(idPeca) {
  const p = CATALOGO.find(x => x.ID_Peca === idPeca);
  return p ? p.Imagem_URL : null;
}

// ---- Modo Bárbara (PIN) ----
function alternarModoAdmin() {
  if (MODO_ADMIN) {
    MODO_ADMIN = false;
    localStorage.removeItem('modoAdmin');
    toast('Modo Bárbara desativado');
    atualizarBotaoModoAdmin();
    renderPainel();
    return;
  }
  const pin = prompt('Digite o PIN pra liberar os controles de status:');
  if (!pin) return;
  api('verificarPin', { pin: pin })
    .then(function (ok) {
      if (ok) {
        MODO_ADMIN = true;
        localStorage.setItem('modoAdmin', 'true');
        toast('Modo Bárbara ativado');
      } else {
        toast('PIN incorreto');
      }
      atualizarBotaoModoAdmin();
      renderPainel();
    })
    .catch(function (err) { toast('Erro: ' + err.message); });
}

function atualizarBotaoModoAdmin() {
  const btn = document.getElementById('btn-modo-admin');
  if (!btn) return;
  btn.textContent = MODO_ADMIN ? '🔓 Modo Bárbara ativo' : '🔒 Liberar controles';
  btn.classList.toggle('ativo', MODO_ADMIN);
}

// ---- Agrupamento por pedido ----
function agruparPedidos(lista) {
  const mapa = {};
  lista.forEach(s => {
    const pid = s.ID_Pedido || s.ID_Solicitacao; // registros antigos sem ID_Pedido caem sozinhos
    if (!mapa[pid]) mapa[pid] = { pedidoId: pid, solicitante: s.Solicitante, dataHora: s.Data_Hora, itens: [] };
    mapa[pid].itens.push(s);
    if (new Date(s.Data_Hora) < new Date(mapa[pid].dataHora)) mapa[pid].dataHora = s.Data_Hora;
  });
  return Object.values(mapa);
}

function statusResumoPedido(pedido) {
  let pior = STATUS_ORDEM.length - 1;
  pedido.itens.forEach(it => {
    const idx = STATUS_ORDEM.indexOf(it.Status);
    if (idx !== -1 && idx < pior) pior = idx;
  });
  return STATUS_ORDEM[pior];
}

function pedidoTemUrgente(pedido) {
  return pedido.itens.some(it => it.Urgente === true);
}

function renderPainel() {
  const wrap = document.getElementById('lista-painel');
  PEDIDOS_CACHE = agruparPedidos(SOLICITACOES);

  let pedidos = PEDIDOS_CACHE;
  if (FILTRO_STATUS !== 'Todos') {
    pedidos = pedidos.filter(pd => statusResumoPedido(pd) === FILTRO_STATUS);
  }
  pedidos = pedidos.slice().sort((a, b) => {
    const ua = pedidoTemUrgente(a) ? 1 : 0;
    const ub = pedidoTemUrgente(b) ? 1 : 0;
    if (ua !== ub) return ub - ua;
    return new Date(b.dataHora) - new Date(a.dataHora);
  });

  wrap.innerHTML = '';
  if (pedidos.length === 0) {
    wrap.innerHTML = '<div class="empty-state"><div class="big">Nada por aqui</div>Sem pedidos nesse filtro.</div>';
    return;
  }
  pedidos.forEach(pd => {
    const urgente = pedidoTemUrgente(pd);
    const statusGeral = statusResumoPedido(pd);
    const nomes = pd.itens.slice(0, 2).map(it => esc(it.Nome_Peca)).join(', ');
    const resto = pd.itens.length > 2 ? ' + ' + (pd.itens.length - 2) : '';
    const div = document.createElement('div');
    div.className = 'ticket' + (urgente ? ' is-urgent' : '');
    div.addEventListener('click', () => abrirDetalhePedido(pd.pedidoId));
    div.innerHTML =
      '<div class="ticket-head">' +
      '<div style="min-width:0;"><div class="ticket-title">' + esc(pd.solicitante) + '</div>' +
      '<div class="ticket-sub">' + pd.itens.length + ' peça' + (pd.itens.length > 1 ? 's' : '') + ' · ' + tempoRelativo(pd.dataHora) + '</div></div>' +
      '<div class="ticket-badges">' +
      (urgente ? '<span class="urgent-badge">Urgente</span>' : '') +
      '<span class="status-badge" data-s="' + esc(statusGeral) + '">' + esc(statusGeral) + '</span>' +
      '</div></div>' +
      '<div class="ticket-perf"></div>' +
      '<div class="ticket-body"><span>' + nomes + resto + '</span></div>';
    wrap.appendChild(div);
  });
}

// ---- Detalhe do pedido (lista de itens dentro) ----
function abrirDetalhePedido(pedidoId) {
  PEDIDO_DETALHE_ATUAL = pedidoId;
  renderDetalhePedidoConteudo();
  document.getElementById('modal-detalhe-pedido').classList.remove('hidden');
}

function fecharDetalhePedido() {
  document.getElementById('modal-detalhe-pedido').classList.add('hidden');
}

function renderDetalhePedidoConteudo() {
  const pd = PEDIDOS_CACHE.find(x => x.pedidoId === PEDIDO_DETALHE_ATUAL);
  if (!pd) { fecharDetalhePedido(); return; }

  document.getElementById('pedido-detalhe-titulo').textContent = pd.solicitante;
  document.getElementById('pedido-detalhe-sub').textContent =
    pd.itens.length + ' peça' + (pd.itens.length > 1 ? 's' : '') + ' · ' + tempoRelativo(pd.dataHora);

  document.getElementById('pedido-admin-actions').style.display = MODO_ADMIN ? 'block' : 'none';

  const confRaw = pd.itens.find(it => it.Confirmacao_URL)?.Confirmacao_URL;
  const confUrls = confRaw ? String(confRaw).split('\n').filter(Boolean) : [];
  const confWrap = document.getElementById('pedido-confirmacao-anexada');
  if (confUrls.length) {
    confWrap.style.display = 'block';
    confWrap.innerHTML = '<label style="font-size:13px; font-weight:600; color:var(--ink-soft); display:block; margin-bottom:6px;">Print' + (confUrls.length > 1 ? 's' : '') + ' anexado' + (confUrls.length > 1 ? 's' : '') + '</label>' +
      '<div class="photos-preview-row">' + confUrls.map(url =>
        '<div class="photo-preview-item" style="width:84px; height:84px;"><img src="' + url + '" style="cursor:zoom-in;" onclick="abrirImagemFullscreen(\'' + url.replace(/'/g, "\\'") + '\')"></div>'
      ).join('') + '</div>';
  } else {
    confWrap.style.display = 'none';
    confWrap.innerHTML = '';
  }

  document.getElementById('pedido-itens-lista').innerHTML = pd.itens.map(renderItemPedidoDetalhe).join('');
}

function renderItemPedidoDetalhe(it) {
  const urgente = it.Urgente === true;
  const thumbUrl = pecaThumbPorId(it.ID_Peca);

  let html = '<div class="pedido-item-row">';
  html += '<div class="pedido-item-head">';
  html += thumbHtml(thumbUrl, 'thumb');
  html += '<div style="flex:1; min-width:0;">';
  html += '<div class="catalog-card-id" style="margin-bottom:2px;">' + esc(it.ID_Peca) + '</div>';
  html += '<div style="font-weight:700; font-size:14px;">' + esc(it.Nome_Peca) + '</div>';
  html += '</div>';
  html += (urgente ? '<span class="urgent-badge">Urgente</span>' : '') +
    '<span class="status-badge" data-s="' + esc(it.Status) + '">' + esc(it.Status) + '</span>';
  html += '</div>';

  html += '<div class="ticket-body" style="padding:8px 0 4px;"><span>Qtd: <b>' + esc(it.Quantidade) + '</b></span></div>';
  if (it.Observacao) html += '<p style="font-size:13px; color:var(--ink-soft); margin:2px 0 6px;">' + esc(it.Observacao) + '</p>';

  if (it.Foto_URL) {
    const urls = String(it.Foto_URL).split('\n').filter(Boolean);
    html += '<div class="photos-preview-row" style="margin-bottom:6px;">' +
      urls.map(url => '<div class="photo-preview-item" style="width:64px; height:64px;">' +
        '<img src="' + url + '" style="cursor:zoom-in;" onclick="abrirImagemFullscreen(\'' + url.replace(/'/g, "\\'") + '\')"></div>').join('') +
      '</div>';
  }

  if (MODO_ADMIN) {
    html += '<div style="display:flex; gap:6px; margin:6px 0;">';
    html += '<input type="number" min="1" inputmode="numeric" value="' + it.Quantidade + '" id="qtd-item-' + it.ID_Solicitacao + '" style="flex:1; padding:8px; border:1.5px solid var(--line); border-radius:8px;">';
    html += '<button type="button" class="btn-secondary" style="width:auto; margin:0; padding:8px 12px;" onclick="salvarQtdItemPedido(\'' + it.ID_Solicitacao + '\')">Salvar qtd</button>';
    html += '</div>';
    html += '<label class="urgent-label" style="margin-bottom:8px;">' +
      '<input type="checkbox" ' + (urgente ? 'checked' : '') + ' onchange="toggleUrgenteItemPedido(\'' + it.ID_Solicitacao + '\', this.checked)">' +
      '<span class="urgent-box">🔴 ' + (urgente ? 'Marcado como urgente' : 'Marcar como urgente') + '</span></label>';
    html += '<div class="status-actions">';
    CONFIG.status.forEach(st => {
      html += '<button type="button" class="' + (st === it.Status ? 'current' : '') + '" onclick="mudarStatusItemPedido(\'' + it.ID_Solicitacao + '\', \'' + st + '\')">' + st + '</button>';
    });
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function acharItemPorId(idSolicitacao) {
  return SOLICITACOES.find(s => s.ID_Solicitacao === idSolicitacao);
}

function exigirModoAdmin() {
  if (!MODO_ADMIN) { toast('Só a Bárbara pode fazer isso. Toque em 🔒 pra liberar.'); return false; }
  return true;
}

function mudarStatusItemPedido(idSolicitacao, novoStatus) {
  if (!exigirModoAdmin()) return;
  api('atualizarStatus', { idSolicitacao: idSolicitacao, novoStatus: novoStatus, usuario: 'Bárbara' })
    .then(function () {
      toast('Status atualizado: ' + novoStatus);
      const it = acharItemPorId(idSolicitacao);
      if (it) it.Status = novoStatus;
      renderDetalhePedidoConteudo();
      renderPainel();
    })
    .catch(function (err) { toast('Erro: ' + err.message); });
}

function toggleUrgenteItemPedido(idSolicitacao, marcado) {
  if (!exigirModoAdmin()) return;
  api('atualizarUrgente', { idSolicitacao: idSolicitacao, urgente: marcado, usuario: 'Bárbara' })
    .then(function () {
      toast(marcado ? 'Marcado como urgente' : 'Urgente removido');
      const it = acharItemPorId(idSolicitacao);
      if (it) it.Urgente = marcado;
      renderDetalhePedidoConteudo();
      renderPainel();
    })
    .catch(function (err) { toast('Erro: ' + err.message); });
}

function salvarQtdItemPedido(idSolicitacao) {
  if (!exigirModoAdmin()) return;
  const novaQtd = Number(document.getElementById('qtd-item-' + idSolicitacao).value);
  if (!novaQtd || novaQtd <= 0) { toast('Quantidade inválida'); return; }
  api('atualizarQuantidade', { idSolicitacao: idSolicitacao, novaQtd: novaQtd, usuario: 'Bárbara' })
    .then(function () {
      toast('Quantidade atualizada');
      const it = acharItemPorId(idSolicitacao);
      if (it) it.Quantidade = novaQtd;
      renderDetalhePedidoConteudo();
      renderPainel();
    })
    .catch(function (err) { toast('Erro: ' + err.message); });
}

// ---- Confirmação por upload (print do pedido feito na Sênior) ----
function handleConfirmacaoPedido(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  if (!exigirModoAdmin()) { e.target.value = ''; return; }
  const pd = PEDIDOS_CACHE.find(x => x.pedidoId === PEDIDO_DETALHE_ATUAL);
  if (!pd) { e.target.value = ''; return; }

  const imagensBase64 = [];
  let restantes = files.length;
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = function (ev) {
      redimensionarBase64(ev.target.result, 1600, function (reduzida) {
        imagensBase64.push(reduzida);
        restantes--;
        if (restantes === 0) enviarImagensConfirmacao(pd, imagensBase64);
      });
    };
    reader.readAsDataURL(file);
  });
  e.target.value = '';
}

function enviarImagensConfirmacao(pd, imagensBase64) {
  const botoes = document.querySelectorAll('#pedido-admin-actions .photo-input, #btn-capturar-tela');
  botoes.forEach(b => b.style.opacity = '0.6');
  api('anexarConfirmacaoPedido', {
    idsSolicitacoes: pd.itens.map(it => it.ID_Solicitacao),
    imagensBase64: imagensBase64,
    usuario: 'Bárbara'
  })
    .then(function (urls) {
      toast('Confirmação anexada — pedido marcado como "Em produção"');
      pd.itens.forEach(it => {
        it.Confirmacao_URL = it.Confirmacao_URL ? it.Confirmacao_URL + '\n' + urls : urls;
        const idxAtual = STATUS_ORDEM.indexOf(it.Status);
        const idxAlvo = STATUS_ORDEM.indexOf('Em produção');
        if (idxAtual !== -1 && idxAtual < idxAlvo) it.Status = 'Em produção';
      });
      renderDetalhePedidoConteudo();
      renderPainel();
    })
    .catch(function (err) { toast('Erro: ' + err.message); })
    .finally(function () { botoes.forEach(b => b.style.opacity = '1'); });
}

// Captura de tela/janela — abre o seletor nativo do sistema (Windows/Mac/Chrome OS)
// e tira um "print" de um frame do que foi escolhido. Só funciona em navegador
// de computador (a API não existe em navegadores de celular).
async function capturarTelaConfirmacao() {
  if (!exigirModoAdmin()) return;
  const pd = PEDIDOS_CACHE.find(x => x.pedidoId === PEDIDO_DETALHE_ATUAL);
  if (!pd) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    toast('Captura de tela não disponível nesse navegador/dispositivo. Use "Escolher arquivo".');
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch (e) {
    return; // usuário cancelou o seletor — não faz nada
  }

  const video = document.createElement('video');
  video.srcObject = stream;
  await video.play();
  // pequena espera pro primeiro frame renderizar de verdade antes de capturar
  await new Promise(r => setTimeout(r, 250));

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);

  stream.getTracks().forEach(t => t.stop());

  const base64 = canvas.toDataURL('image/png');
  redimensionarBase64(base64, 1600, function (reduzida) {
    enviarImagensConfirmacao(pd, [reduzida]);
  });
}

// ---------------------------------------------------------
// ESCANEAR QR — câmera ao vivo com fallback pra foto
// ---------------------------------------------------------
let SCAN_STREAM = null;
let SCAN_RAF = null;
let SCAN_CANVAS = null;
let SCAN_CALLBACK = null;

function abrirScanQR(callback) {
  SCAN_CALLBACK = callback || function (p) { abrirMovimento(p.ID_Peca); };
  document.getElementById('inp-codigo-manual').value = '';
  document.getElementById('scan-qr-status').textContent = '';
  document.getElementById('scan-fallback').style.display = 'none';
  document.getElementById('scan-video-wrap').style.display = 'block';
  document.getElementById('modal-scan-qr').classList.remove('hidden');

  if (typeof jsQR === 'undefined') {
    // Biblioteca de leitura de QR não carregou (conexão lenta, CDN fora do ar, etc).
    // Não adianta abrir a câmera se não dá pra decodificar o que ela vê.
    ativarFallbackFoto('A biblioteca de leitura de QR ainda não carregou. Verifique sua internet e recarregue a página.');
    return;
  }
  iniciarCameraScan();
}

function fecharScanQR() {
  document.getElementById('modal-scan-qr').classList.add('hidden');
  pararCameraScan();
}

async function iniciarCameraScan() {
  // Se o browser nem sequer expõe a API, cai direto no fallback
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    ativarFallbackFoto('Este navegador não tem API de câmera.');
    return;
  }
  try {
    SCAN_STREAM = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false
    });
    const video = document.getElementById('scan-video');
    video.srcObject = SCAN_STREAM;
    await video.play();
    document.getElementById('scan-qr-status').textContent = 'Aponte a câmera para o QR code da etiqueta';
    SCAN_CANVAS = document.createElement('canvas');
    lerFrame();
  } catch (err) {
    ativarFallbackFoto('Câmera bloqueada: ' + (err.message || err.name || 'permissão negada'));
  }
}

function lerFrame() {
  const video = document.getElementById('scan-video');
  if (!SCAN_STREAM || !video || video.readyState !== video.HAVE_ENOUGH_DATA) {
    SCAN_RAF = requestAnimationFrame(lerFrame);
    return;
  }
  SCAN_CANVAS.width = video.videoWidth;
  SCAN_CANVAS.height = video.videoHeight;
  const ctx = SCAN_CANVAS.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, SCAN_CANVAS.width, SCAN_CANVAS.height);
  const imageData = ctx.getImageData(0, 0, SCAN_CANVAS.width, SCAN_CANVAS.height);
  const resultado = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
  if (resultado && resultado.data) {
    pararCameraScan();
    buscarPecaEscaneada(resultado.data);
    return;
  }
  SCAN_RAF = requestAnimationFrame(lerFrame);
}

function pararCameraScan() {
  if (SCAN_RAF) { cancelAnimationFrame(SCAN_RAF); SCAN_RAF = null; }
  if (SCAN_STREAM) {
    SCAN_STREAM.getTracks().forEach(t => t.stop());
    SCAN_STREAM = null;
  }
  const video = document.getElementById('scan-video');
  if (video) video.srcObject = null;
}

function ativarFallbackFoto(motivo) {
  document.getElementById('scan-video-wrap').style.display = 'none';
  document.getElementById('scan-fallback').style.display = 'block';
  document.getElementById('scan-qr-status').textContent = motivo || '';
}

function confirmarCodigoManual() {
  const codigo = document.getElementById('inp-codigo-manual').value.trim();
  if (!codigo) { toast('Digite ou escaneie um código'); return; }
  buscarPecaEscaneada(codigo);
}

function handleFotoQR(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (typeof jsQR === 'undefined') {
    document.getElementById('scan-qr-status').textContent = 'A biblioteca de leitura de QR não carregou. Recarregue a página.';
    return;
  }
  document.getElementById('scan-qr-status').textContent = 'Lendo QR code...';
  const reader = new FileReader();
  reader.onload = function (ev) {
    const img = new Image();
    img.onload = function () {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const resultado = jsQR(imageData.data, canvas.width, canvas.height);
      if (resultado && resultado.data) {
        document.getElementById('scan-qr-status').textContent = '';
        buscarPecaEscaneada(resultado.data);
      } else {
        document.getElementById('scan-qr-status').textContent = 'Não consegui ler o QR nessa foto. Tente de novo, bem de frente e com boa luz.';
      }
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

function buscarPecaEscaneada(codigo) {
  const p = CATALOGO.find(x => String(x.ID_Peca).trim().toLowerCase() === String(codigo).trim().toLowerCase());
  if (!p) { document.getElementById('scan-qr-status').textContent = 'Peça "' + codigo + '" não encontrada no catálogo.'; return; }
  fecharScanQR();
  if (SCAN_CALLBACK) SCAN_CALLBACK(p);
}

// ---------------------------------------------------------
// ENTRADA / SAÍDA DE ESTOQUE
// ---------------------------------------------------------
function abrirMovimento(idPeca) {
  const p = CATALOGO.find(x => x.ID_Peca === idPeca);
  if (!p) { toast('Peça não encontrada'); return; }
  MOVIMENTO_PECA_ATUAL = p;
  MOVIMENTO_TIPO_ATUAL = 'entrada';

  document.getElementById('movimento-id').textContent = p.Nome_Peca;
  document.getElementById('movimento-nome').textContent = p.ID_Peca;
  document.getElementById('movimento-qtd').value = 1;
  document.getElementById('movimento-obs').value = '';
  document.querySelectorAll('.movimento-tipo-btn').forEach(b => b.classList.toggle('selected', b.dataset.tipo === 'entrada'));
  const btnConfirmar = document.getElementById('btn-confirmar-movimento');
  btnConfirmar.disabled = false;
  btnConfirmar.textContent = 'Confirmar';
  atualizarPreviewMovimento();
  document.getElementById('modal-movimento').classList.remove('hidden');
}

function fecharMovimento() {
  document.getElementById('modal-movimento').classList.add('hidden');
}

function abrirMovimentoRapido(idPeca, tipo) {
  abrirMovimento(idPeca);
  const btn = document.querySelector('.movimento-tipo-btn[data-tipo="' + tipo + '"]');
  if (btn) selecionarTipoMovimento(tipo, btn);
}

function selecionarTipoMovimento(tipo, el) {
  MOVIMENTO_TIPO_ATUAL = tipo;
  document.querySelectorAll('.movimento-tipo-btn').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
  atualizarPreviewMovimento();
}

function ajustarQtdMovimento(delta) {
  const inp = document.getElementById('movimento-qtd');
  const novo = Math.max(1, (Number(inp.value) || 1) + delta);
  inp.value = novo;
  atualizarPreviewMovimento();
}

function atualizarPreviewMovimento() {
  if (!MOVIMENTO_PECA_ATUAL) return;
  const atual = Number(MOVIMENTO_PECA_ATUAL['Estoque_Atual']) || 0;
  const qtd = Math.max(1, Number(document.getElementById('movimento-qtd').value) || 1);
  const novo = MOVIMENTO_TIPO_ATUAL === 'entrada' ? atual + qtd : Math.max(0, atual - qtd);
  document.getElementById('movimento-preview').innerHTML =
    'Estoque atual: <b>' + atual + '</b> <span style="color:var(--ink-soft);">→</span> <b class="movimento-novo-' + (MOVIMENTO_TIPO_ATUAL === 'entrada' ? 'up' : 'down') + '">' + novo + '</b>';
}

function confirmarMovimento() {
  if (!MOVIMENTO_PECA_ATUAL) return;
  const qtd = Math.max(1, Number(document.getElementById('movimento-qtd').value) || 1);
  const obs = document.getElementById('movimento-obs').value.trim();
  const usuario = localStorage.getItem('nomeUsuario') || 'Desconhecido';

  const btn = document.getElementById('btn-confirmar-movimento');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Salvando...';

  api('registrarMovimentoEstoque', { idPeca: MOVIMENTO_PECA_ATUAL.ID_Peca, tipo: MOVIMENTO_TIPO_ATUAL, quantidade: qtd, observacao: obs, usuario: usuario })
    .then(function (novoValor) {
      toast('Estoque atualizado: ' + novoValor);
      // Atualiza direto no array que já está na tela (é a mesma referência
      // usada pelo card do catálogo) — não precisa buscar tudo de novo no
      // servidor, então o número muda na hora, sem esperar nem dar refresh.
      MOVIMENTO_PECA_ATUAL['Estoque_Atual'] = novoValor;
      btn.disabled = false;
      btn.textContent = 'Confirmar';
      fecharMovimento();
      renderCatalogoLista();
    })
    .catch(function (err) {
      toast('Erro: ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Confirmar';
    });
}

// ---------------------------------------------------------
// ETIQUETAS (impressão com QR code — janela dedicada, 107x48mm)
// ---------------------------------------------------------
const LOGO_PERFINORTE_B64 = 'data:image/png;base64,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';

function imprimirEtiquetaUnica(idPeca) {
  const p = CATALOGO.find(x => x.ID_Peca === idPeca);
  if (!p) { toast('Salve a peça antes de imprimir a etiqueta'); return; }
  montarEImprimirEtiquetas([p]);
}

function imprimirEtiquetasCatalogo() {
  const termo = (document.getElementById('inp-busca-catalogo').value || '').toLowerCase();
  let lista = CATALOGO.filter(p =>
    (p.Nome_Peca || '').toLowerCase().includes(termo) ||
    String(p.ID_Peca || '').toLowerCase().includes(termo)
  );
  if (FILTRO_LINHA_CATALOGO !== 'Todas') lista = lista.filter(p => p.Linha === FILTRO_LINHA_CATALOGO);
  if (!lista.length) { toast('Nenhuma peça pra imprimir'); return; }
  montarEImprimirEtiquetas(lista);
}

function montarEImprimirEtiquetas(lista) {
  mostrarProgressoImpressao(0, lista.length);

  const holder = document.createElement('div');
  holder.style.position = 'fixed';
  holder.style.left = '-9999px';
  document.body.appendChild(holder);
  const qr = new QRCode(holder, { width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });

  const qrDataUrls = new Array(lista.length);
  let i = 0;
  let terminou = false;

  // Watchdog: se o contador não avançar por 5s seguidos, algo travou —
  // avisa em vez de deixar girando pra sempre, e sugere um contorno imediato.
  let ultimoIVisto = -1;
  const watchdog = setInterval(function () {
    if (terminou) { clearInterval(watchdog); return; }
    if (i === ultimoIVisto) {
      clearInterval(watchdog);
      terminou = true;
      const overlay = document.getElementById('print-progress-overlay');
      if (overlay) overlay.remove();
      if (document.body.contains(holder)) document.body.removeChild(holder);
      toast('Travou gerando a etiqueta ' + (i + 1) + '/' + lista.length + '. Tenta filtrar por Linha e imprimir em grupos menores.');
    }
    ultimoIVisto = i;
  }, 5000);

  function gerarProximo() {
    if (terminou) return;
    if (i >= lista.length) {
      terminou = true;
      clearInterval(watchdog);
      document.body.removeChild(holder);
      imprimirViaIframe(lista, qrDataUrls);
      return;
    }

    // Alguns valores de ID (ex: os que viraram data sem querer na planilha)
    // podem quebrar essa biblioteca de QR pra certos tamanhos de texto.
    // Se acontecer, pula só essa etiqueta (fica sem QR) e segue pras outras
    // em vez de travar a impressão toda.
    let falhou = false;
    try {
      qr.clear();
      qr.makeCode(String(lista[i].ID_Peca));
    } catch (e) {
      console.warn('QR falhou para', lista[i].ID_Peca, e);
      falhou = true;
    }

    if (falhou) {
      qrDataUrls[i] = '';
      i++;
      mostrarProgressoImpressao(i, lista.length);
      gerarProximo();
      return;
    }

    setTimeout(function () {
      if (terminou) return;
      const canvas = holder.querySelector('canvas');
      const img = holder.querySelector('img');
      qrDataUrls[i] = canvas ? canvas.toDataURL('image/png') : (img ? img.src : '');
      i++;
      mostrarProgressoImpressao(i, lista.length);
      gerarProximo();
    }, 0);
  }

  gerarProximo();
}

function mostrarProgressoImpressao(atual, total) {
  let overlay = document.getElementById('print-progress-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'print-progress-overlay';
    overlay.className = 'print-progress-overlay';
    overlay.innerHTML = '<div class="print-progress-box"><span class="spinner" style="border-top-color:var(--accent); border-color:rgba(0,0,0,0.15);"></span> Gerando etiquetas... <span id="print-progress-num"></span></div>';
    document.body.appendChild(overlay);
  }
  document.getElementById('print-progress-num').textContent = atual + '/' + total;
  if (atual >= total) {
    setTimeout(() => { const o = document.getElementById('print-progress-overlay'); if (o) o.remove(); }, 400);
  }
}

function imprimirViaIframe(lista, qrDataUrls) {
 try {
  const largura = p => p['Largura do Produto'];
  const comprimento = p => p['Comprimento do Produto'];

  const labelsHtml = lista.map((p, i) => {
    const dims = (largura(p) || comprimento(p)) ? (esc(largura(p) || '') + '×' + esc(comprimento(p) || '') + 'mm') : '';
    const temFoto = !!p.Imagem_URL;
    return '<div class="label">' +
      '<div class="label-top">' +
      '<div class="label-qr-wrap">' +
      (qrDataUrls[i] ? '<img class="label-qr" src="' + qrDataUrls[i] + '">' : '<div class="label-qr-vazio">QR indisponível<br>pra esta peça</div>') +
      '</div>' +
      '<div class="label-specs">' +
      '<div class="label-id-box">' + esc(p.ID_Peca) + '</div>' +
      '<div class="label-meta-block">' +
      (p.MP ? '<div class="label-meta">MP: ' + esc(p.MP) + (p.Espessura ? ' de ' + esc(formatarEspessura(p.Espessura)) : '') + '</div>' : '') +
      (dims ? '<div class="label-meta">' + dims + '</div>' : '') +
      (p.Servicos ? '<div class="label-meta">Serviço: ' + esc(p.Servicos) + '</div>' : '') +
      '</div>' +
      '</div>' +
      '<div class="label-photo-wrap">' +
      (temFoto ? '<img class="label-photo" src="' + p.Imagem_URL + '">' : '<div class="label-photo-vazio">sem foto</div>') +
      '</div>' +
      '</div>' +
      '<div class="label-bottom">' +
      '<div class="label-name">' + esc(p.Nome_Peca) + '</div>' +
      '<img class="label-logo" src="' + LOGO_PERFINORTE_B64 + '">' +
      '</div>' +
      '</div>';
  }).join('');

  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Etiquetas</title><style>' +
    '@page { size: 107mm 48mm; margin: 0; }' +
    '* { box-sizing: border-box; }' +
    'body { margin: 0; font-family: Arial, Helvetica, sans-serif; }' +
    '.label { width: 107mm; height: 48mm; padding: 3mm; display: flex; flex-direction: column; gap: 1.2mm; page-break-after: always; overflow: hidden; }' +
    '.label-top { display: flex; gap: 2mm; flex: 1; min-height: 0; }' +
    '.label-qr-wrap, .label-photo-wrap { flex: none; width: 30mm; display: flex; align-items: flex-start; justify-content: center; }' +
    '.label-qr { width: 30mm; height: 30mm; display: block; }' +
    '.label-photo { width: 30mm; height: 30mm; display: block; object-fit: contain; border-radius: 2.5mm; border: 0.3mm solid #ddd; padding: 0.8mm; }' +
    '.label-qr-vazio, .label-photo-vazio { width: 30mm; height: 30mm; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 6.5pt; color: #999; border: 1px dashed #ccc; border-radius: 2.5mm; box-sizing: border-box; }' +
    '.label-specs { flex: 1; min-width: 0; display: flex; flex-direction: column; }' +
    '.label-id-box { display: inline-block; align-self: flex-start; border: 0.5mm solid #1a1a1a; border-radius: 1mm; padding: 0.8mm 2mm; font-size: 14pt; font-weight: 800; color: #1a1a1a; line-height: 1.15; }' +
    '.label-meta-block { margin-top: 1.5mm; }' +
    '.label-meta { font-size: 7.8pt; color: #333; font-weight: 600; margin-top: 0.8mm; line-height: 1.3; }' +
    '.label-bottom { display: flex; align-items: flex-end; gap: 2mm; flex: none; }' +
    '.label-name { flex: 1; min-width: 0; font-size: 9pt; font-weight: 700; color: #1a1a1a; line-height: 1.2; max-height: 8.8mm; overflow: hidden; }' +
    '.label-logo { height: 4.5mm; flex: none; display: block; }' +
    '</style></head><body>' + labelsHtml + '</body></html>';

  // iframe escondido na PRÓPRIA aba — ao contrário de window.open(), nunca fica
  // em segundo plano, então o navegador (Safari no iPhone principalmente) não
  // pausa a geração no meio do caminho.
  let iframe = document.getElementById('print-iframe');
  if (iframe) iframe.remove();
  iframe = document.createElement('iframe');
  iframe.id = 'print-iframe';
  iframe.style.cssText = 'position:fixed; right:0; bottom:0; width:0; height:0; border:none;';
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();

  // onload de iframe preenchido via document.write() nem sempre dispara de
  // forma confiável — por segurança, tenta imprimir tanto pelo onload quanto
  // por um temporizador de reforço, o que disparar primeiro vence.
  let jaImprimiu = false;
  function dispararImpressao() {
    if (jaImprimiu) return;
    jaImprimiu = true;
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch (e) {
      toast('Erro ao abrir impressão: ' + e.message);
    }
  }
  iframe.onload = function () { setTimeout(dispararImpressao, 150); };
  setTimeout(dispararImpressao, 700);
 } catch (e) {
  toast('Erro ao montar etiquetas: ' + e.message);
 }
}

// ---------------------------------------------------------
// UTIL
// ---------------------------------------------------------
// A planilha guarda Espessura como número puro (2, 2.25, 6.3...), e o JS
// perde o zero à direita ao ler isso (2.00 vira só "2"). Essa função formata
// sempre com 2 casas e vírgula, do jeito que o pessoal do chão de fábrica
// está acostumado a ver (2,00 / 2,25 / 6,30). Se o valor já for texto (não
// numérico), mantém como está, sem tentar reformatar.
function formatarEspessura(valor) {
  if (valor === undefined || valor === null || valor === '') return '';
  const n = Number(valor);
  if (isNaN(n)) return String(valor);
  return n.toFixed(2).replace('.', ',');
}

function esc(str) {
  if (str === undefined || str === null) return '';
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function tempoRelativo(isoStr) {
  if (!isoStr) return '';
  const diffMs = Date.now() - new Date(isoStr).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return min + ' min atrás';
  const h = Math.floor(min / 60);
  if (h < 24) return h + 'h atrás';
  const d = Math.floor(h / 24);
  return d + 'd atrás';
}
