// ============================================================
// Catálogo público (só consulta) — versão enxuta do app principal,
// sem escanear QR, sem imprimir etiqueta, sem entrada/saída de estoque.
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

function esc(str) {
  if (str === undefined || str === null) return '';
  return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// A planilha guarda Espessura como número puro — formata sempre com vírgula
// e 2 casas (2,00 / 2,25 / 6,30), igual ao app principal.
function formatarEspessura(valor) {
  if (valor === undefined || valor === null || valor === '') return '';
  const n = Number(valor);
  if (isNaN(n)) return String(valor);
  return n.toFixed(2).replace('.', ',');
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

let CONFIG = { linhas: [] };
let CATALOGO = [];
let FILTRO_LINHA = 'Todas';

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('lista-catalogo').innerHTML = '<div class="empty-state">Carregando peças...</div>';
  document.getElementById('inp-busca').addEventListener('input', renderLista);

  api('getConfig')
    .then(function (cfg) {
      CONFIG = cfg;
      montarChipsLinha();
    })
    .catch(function (err) { toast('Erro ao carregar configuração: ' + err.message); });

  carregarCatalogo();
});

function carregarCatalogo() {
  api('getCatalogo')
    .then(function (lista) {
      CATALOGO = lista || [];
      renderLista();
    })
    .catch(function (err) {
      document.getElementById('lista-catalogo').innerHTML =
        '<div class="empty-state"><div class="big">Erro ao carregar</div>' + esc(err.message) + '</div>';
    });
}

function montarChipsLinha() {
  const wrap = document.getElementById('linha-chips');
  const opcoes = ['Todas'].concat(CONFIG.linhas || []);
  wrap.innerHTML = opcoes.map((l, i) =>
    '<div class="filter-chip' + (i === 0 ? ' selected' : '') + '" data-linha="' + esc(l) + '">' + esc(l) + '</div>'
  ).join('');
  wrap.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      wrap.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
      FILTRO_LINHA = chip.dataset.linha;
      renderLista();
    });
  });
}

function renderLista() {
  const termo = (document.getElementById('inp-busca').value || '').toLowerCase();
  const wrap = document.getElementById('lista-catalogo');
  let filtradas = CATALOGO.filter(p =>
    (p.Nome_Peca || '').toLowerCase().includes(termo) ||
    String(p.ID_Peca || '').toLowerCase().includes(termo)
  );
  if (FILTRO_LINHA !== 'Todas') filtradas = filtradas.filter(p => p.Linha === FILTRO_LINHA);

  wrap.innerHTML = '';
  if (filtradas.length === 0) {
    wrap.innerHTML = '<div class="empty-state"><div class="big">Nada encontrado</div>' +
      (CATALOGO.length === 0 ? 'Nenhuma peça carregada ainda.' : 'Tenta outro termo de busca.') + '</div>';
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
      ? '<img src="' + p.Imagem_URL + '" onclick="abrirImagemFullscreen(\'' + p.Imagem_URL.replace(/'/g, "\\'") + '\')">'
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
      '</div>';
    wrap.appendChild(div);
  });
}

// ---- Lightbox (visualizar foto em tela cheia, com rotação) ----
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
